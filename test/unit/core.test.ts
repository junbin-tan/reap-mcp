import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Commerce } from "../../src/commerce.js";
import { Database } from "../../src/db.js";
import type { Quote } from "../../src/domain.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ReapProvider } from "../../src/providers/reap.js";
import { localIdentity } from "../../src/runtime.js";
import { loadConfig, validateRemoteConfig, type Config } from "../../src/config.js";
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

describe("sandbox provider compatibility", () => {
  test("accepts a null payment method while enrollment is pending", async () => {
    const config = loadConfig(env());
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      id: "enrollment-1", status: "REQUIRES_ACTION", owner: { type: "CLIENT_REFERENCE", id: "owner-1" },
      paymentMethod: null, nextAction: null,
    }));
    const provider = new ReapProvider(config, fetcher);
    await expect(provider.enrollment("enrollment-1")).resolves.toMatchObject({ id: "enrollment-1", masked_label: null, status: "REQUIRES_ACTION" });
    expect(fetcher).toHaveBeenCalledWith(new URL("https://sg.sandbox.api.reap.global/agentic/enrollments/enrollment-1"), expect.objectContaining({ method: "GET" }));
  });

  test("allows an empty merchant list only with explicit all-merchant opt-in", () => {
    expect(() => loadConfig({ ...env(), ALLOWED_MERCHANTS: "{}" })).toThrow(/ALLOWED_MERCHANTS/);
    expect(loadConfig({ ...env(), ALLOWED_MERCHANTS: "{}", ALLOW_ALL_MERCHANTS: "true" })).toHaveProperty("allowAllMerchants", true);
    expect(() => loadConfig({ ...env(), ALLOW_ALL_MERCHANTS: "true", PURCHASE_CAPS: "{}" })).toThrow(/PURCHASE_CAPS/);
  });

  test.each([false, true])("keeps unknown merchants filtered unless opted in: %s", async (allowAll) => {
    const config = loadConfig({ ...env(), ALLOW_ALL_MERCHANTS: String(allowAll) });
    const db = new Database(config);
    const identity = localIdentity(config);
    vi.spyOn(db, "actor").mockResolvedValue({ ...identity, id: "user-1", ownerReference: "owner-1" });
    vi.spyOn(db, "rateLimit").mockResolvedValue();
    vi.spyOn(db, "audit").mockResolvedValue();
    vi.spyOn(db, "query").mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000001" }]);
    const provider = new ReapProvider(config);
    const search = vi.spyOn(provider, "search").mockResolvedValue({ products: [{
      id: "product-1", name: "Coffee", merchant: "Another Coffee Merchant", available: true, image_url: null,
      price_range: { min: money("18.50", "USD"), max: money("18.50", "USD") }, preview_variant: null,
    }], warnings: [], next_cursor: null });
    try {
      const commerce = new Commerce(db, provider, config);
      const result = await commerce.call("search_products", { query: "coffee", country: "US", currency: "USD" }, identity);
      expect(result.ok).toBe(true);
      expect(result.data?.products).toHaveLength(allowAll ? 1 : 0);
      if (allowAll) {
        expect(result.data?.products).toEqual([expect.objectContaining({ merchant: { key: "Another Coffee Merchant", name: "Another Coffee Merchant" } })]);
        const preferred = await commerce.call("search_products", { query: "coffee", country: "US", currency: "USD", merchant_preference: "Another Coffee Merchant" }, identity);
        expect(preferred.ok).toBe(true);
        expect(preferred.data?.products).toHaveLength(1);
        expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ merchant: "Another Coffee Merchant" }));
        const other = await commerce.call("search_products", { query: "coffee", country: "US", currency: "USD", merchant_preference: "Different Merchant" }, identity);
        expect(other.data?.products).toHaveLength(0);
      }
    } finally { await db.close(); }
  });
});

describe("mock catalog and quote consistency", () => {
  const databases: Database[] = [];
  afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });

  function fixture(scenario: Config["mockScenario"] = "success") {
    const db = new Database(loadConfig({ ...env(), MOCK_SCENARIO: scenario }));
    databases.push(db);
    const query = vi.spyOn(db, "query").mockRejectedValue(new Error("Unexpected database access"));
    return { db, query, provider: new MockProvider(db, db.config) };
  }

  test("filters mock prices before pagination, including an empty affordable catalog", async () => {
    const { provider, query } = fixture();
    const input = { query: "coffee", country: "US", currency: "USD", limit: 1, max_item_price: "12.00" };
    const page = await provider.search(input);
    expect(page.products.map((product) => product.id)).toEqual(["mock-mug"]);
    expect(page.next_cursor).toBeNull();
    expect((await provider.search({ ...input, max_item_price: "0" })).products).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  test("uses the same grind labels and availability in details and variants without sharing mutable fixtures", async () => {
    const { provider } = fixture();
    const details = await provider.details("mock-beans");
    const soldOut = details.options[0]!.values.find((value) => value.option_id === "sold-out")!;
    expect(await provider.variant("mock-beans", [soldOut.option_id])).toMatchObject({
      name: soldOut.label, options: [{ name: "Grind", value: soldOut.label }], available: false,
    });
    details.options[0]!.values[0]!.label = "Changed by a caller";
    expect((await provider.details("mock-beans")).options[0]!.values[0]!.label).toBe("Whole beans");
    await expect(provider.variant("mock-beans", ["invalid"])).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test.each(["changed_price", "shipping"] as const)("keeps raw and normalized totals aligned after %s", async (action) => {
    const { db, query, provider } = fixture(action === "shipping" ? "success" : action);
    const quote: Quote = {
      id: "quote-1", expires_at: new Date(Date.now() + 60_000).toISOString(),
      shipping_options: [
        { id: "standard", name: "Standard", selected: true, price: money("4", "USD"), details: [] },
        { id: "express", name: "Express", selected: false, price: money("9", "USD"), details: [] },
      ],
      breakdown: { items_subtotal: money("12", "USD"), shipping: money("4", "USD"), tax: null,
        discounts: [], additional_charges: [], final_amount: money("16", "USD") },
      raw_amounts: { final_amount: "16.00" },
    };
    const stored = { kind: "quote", value: quote, scenario: db.config.mockScenario, callback: null, quote: null, price_changed: false, reads: 0 };
    query.mockResolvedValue([{ data_ciphertext: db.box.seal(stored, `mock:${quote.id}`) }]);
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
    vi.spyOn(db, "locked").mockImplementation(async (_key, work) => work(client));
    vi.spyOn(db, "transaction").mockImplementation(async (work) => work(client));
    let updated: Quote;
    if (action === "shipping") {
      query.mockResolvedValueOnce([]);
      const result = await provider.execute(provider.shippingRequest(quote.id, "express"), "stable-shipping-key");
      if (result.kind !== "quote") throw new Error("Expected a quote result");
      updated = result.value;
      expect(updated.shipping_options.find((option) => option.selected)?.id).toBe("express");
    } else updated = await provider.quote(quote.id);
    expect(updated.breakdown.final_amount.amount).toBe(action === "shipping" ? "21.00" : "17.00");
    expect(updated.raw_amounts.final_amount).toBe(updated.breakdown.final_amount.amount);
  });

  test("rate-limit simulation fails once and then permits the same search", async () => {
    const { provider, query } = fixture("rate_limit");
    query.mockResolvedValueOnce([{ requests: 1 }]).mockResolvedValueOnce([{ requests: 2 }]);
    const input = { query: "coffee", country: "US", currency: "USD", limit: 5 };
    await expect(provider.search(input)).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED", retryable: true });
    expect((await provider.search(input)).products).toHaveLength(2);
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
