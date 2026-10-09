import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { loadConfig, validateRemoteConfig } from "../../src/config.js";
import { money, withinBudget } from "../../src/money.js";
import { CryptoBox, canonical, safeText, safeUrl } from "../../src/security.js";
import { inputSchemas } from "../../src/schemas.js";

const env = () => ({ DATABASE_URL: "postgresql://test:test@127.0.0.1/test", DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), PURCHASE_CAPS: '{"USD":"100.00"}' });

describe("configuration and transport boundaries", () => {
  test("defaults to a loopback-only mock", () => {
    const config = loadConfig(env());
    expect(config.mode).toBe("mock");
    expect(config.reap.checkoutEnabled).toBe(false);
    expect(() => validateRemoteConfig(config)).toThrow(/OAUTH/);
  });
  test.each(["https://sg.prod.api.reap.global", "https://sg.sandbox.api.reap.global.evil.test", "http://sg.sandbox.api.reap.global", "https://sg.sandbox.api.reap.global/private", "https://user@sg.sandbox.api.reap.global"])("rejects unsafe provider host %s", (url) => {
    expect(() => loadConfig({ ...env(), REAP_BASE_URL: url })).toThrow(/REAP_BASE_URL/);
  });
  test("rejects public unauthenticated/plaintext commerce and missing caps", () => {
    expect(() => loadConfig({ ...env(), PUBLIC_BASE_URL: "http://commerce.example" })).toThrow(/HTTPS/);
    expect(() => loadConfig({ ...env(), BIND_HOST: "0.0.0.0" })).toThrow(/HTTPS/);
    expect(() => loadConfig({ ...env(), PURCHASE_CAPS: "{}" })).toThrow(/PURCHASE_CAPS/);
    expect(() => loadConfig({ ...env(), SANDBOX_SIMULATE_CHECKOUT: "yes" })).toThrow();
  });
  test("requires an exact resource audience and allowlisted subjects", () => {
    const config = loadConfig({ ...env(), PUBLIC_BASE_URL: "https://commerce.example", OAUTH_ISSUER: "https://auth.example", OAUTH_AUDIENCE: "https://wrong.example/mcp", ALLOWED_SUBJECTS: "alice" });
    expect(() => validateRemoteConfig(config)).toThrow(/OAUTH_AUDIENCE/);
  });
});

describe("money and data minimization", () => {
  test("does not use floating-point addition or guess currency units", () => {
    expect(money("1234", "USD", "minor")).toEqual({ amount: "12.34", currency: "USD" });
    expect(money("12", "JPY")).toEqual({ amount: "12", currency: "JPY" });
    expect(money("1234", "KWD", "minor").amount).toBe("1.234");
    expect(money("9007199254740993", "USD").amount).toBe("9007199254740993.00");
    expect(withinBudget(money("0.30", "USD"), "0.30", "0.30")).toBe(true);
    expect(withinBudget(money("0.31", "USD"), "0.30", null)).toBe(false);
    expect(() => money("1.001", "USD")).toThrow(/precision/);
    expect(() => money("1.5", "USD", "minor")).toThrow(/integers/);
    expect(() => money("NaN", "USD")).toThrow();
  });
  test("encrypts with unique nonces and binds ciphertext to its owner/resource", () => {
    const box = new CryptoBox(randomBytes(32));
    const source = { address: "private address", email: "private@example.test" };
    const sealed = box.seal(source, "alice:purchase:1");
    expect(sealed).not.toContain("private");
    expect(box.seal(source, "alice:purchase:1")).not.toBe(sealed);
    expect(box.open(sealed, "alice:purchase:1")).toEqual(source);
    expect(() => box.open(sealed, "bob:purchase:1")).toThrow(/private data/);
    expect(box.verify("consent", box.sign("consent"))).toBe(true);
    expect(box.verify("other", box.sign("consent"))).toBe(false);
  });
  test("canonical hashes are stable and merchant markup is inert data", () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
    expect(safeText('<script>alert(1)</script>Beans\u0000')).toBe("alert(1)Beans");
  });
  test("validates exact hosts, not URL prefixes", () => {
    const config = loadConfig({ ...env(), REAP_HOSTED_URL_HOSTS: "approve.example" });
    expect(safeUrl("https://approve.example/consent?ref=x", config)).toContain("approve.example");
    for (const url of ["javascript:alert(1)", "https://approve.example.evil.test", "https://approve.example@evil.test", "https://approve.example:8443", "https://approve.example/#x"]) {
      expect(() => safeUrl(url, config)).toThrow();
    }
  });
});

describe("five strict public contracts", () => {
  test("publishes no extra tools or model-controlled identities/approval", () => {
    expect(Object.keys(inputSchemas)).toEqual(["connect_payment_method", "search_products", "prepare_purchase", "request_purchase", "get_purchase_status"]);
    expect(inputSchemas.connect_payment_method.safeParse({ user_id: "alice" }).success).toBe(false);
    expect(inputSchemas.connect_payment_method.safeParse({ pan: "not-accepted" }).success).toBe(false);
    expect(inputSchemas.request_purchase.safeParse({ purchase_id: "00000000-0000-4000-8000-000000000001", payment_method_id: "00000000-0000-4000-8000-000000000002", expected_revision: 1, user_approved: true }).success).toBe(false);
  });
  test("has a strict discriminated preparation union", () => {
    expect(inputSchemas.prepare_purchase.safeParse({ action: "select_shipping", purchase_id: "00000000-0000-4000-8000-000000000001", expected_revision: 1, shipping_option_id: "standard", country: "US" }).success).toBe(false);
    expect(inputSchemas.search_products.safeParse({ query: "coffee", country: "US", currency: "USD", limit: 11 }).success).toBe(false);
  });
});
