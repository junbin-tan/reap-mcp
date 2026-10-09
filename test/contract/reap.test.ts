import { randomBytes } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { checkSandbox, parseCheckArgs } from "../../scripts/sandbox-check.js";
import { Commerce } from "../../src/commerce.js";
import { loadConfig } from "../../src/config.js";
import { Database } from "../../src/db.js";
import type { ProviderRequest } from "../../src/domain.js";
import { ReapProvider } from "../../src/providers/reap.js";

const config = (overrides: NodeJS.ProcessEnv = {}) => loadConfig({
  APP_MODE: "sandbox", PUBLIC_BASE_URL: "https://callback.example", DATABASE_URL: "postgresql://test:test@127.0.0.1/test",
  DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), PURCHASE_CAPS: '{"USD":"100.00"}', REAP_API_KEY: "test-only-key",
  REAP_PROJECT_REFERENCE: "contract-test", ALLOWED_COUNTRIES: "US", ALLOWED_CURRENCIES: "USD", ALLOWED_MERCHANTS: '{"coffee":"Coffee Merchant"}',
  REAP_MONEY_UNIT: "major", REAP_HOSTED_URL_HOSTS: "approval.example", ...overrides,
});
const amount = (value = 19.99) => ({ amount: value, currency: "USD" });
const variant = { id: "variant-1", name: "Ground / 1 lb", options: [{ name: "Type", value: "Ground" }], price: amount(), available: true };
const product = { id: "product-1", name: "Coffee", merchant: { name: "Coffee Merchant" }, priceRange: { min: amount(), max: amount(39.99) }, available: true };
const search = { products: [product], pagination: { nextCursor: "page-2" }, warnings: [] };
const details = { products: [{ id: "product-1", name: "Coffee", merchant: product.merchant,
  options: [{ name: "Type", values: [{ optionId: "ground", label: "Ground", available: true }] }], defaultVariant: variant }], errors: [] };
const quote = { id: "quote-1", expiresAt: "2030-01-01T00:00:00Z",
  shippingOptions: [{ id: "standard", name: "Standard", selected: true, price: amount(4) }],
  amountBreakdown: { itemsSubtotal: amount(), shipping: amount(4), tax: { amount: amount(1), includedInPrices: true },
    discounts: [], additionalCharges: [], finalAmount: amount(23.99) } };
const response = (body: unknown, status = 200) => Response.json(body, { status });

function setup(...bodies: unknown[]) {
  const fetcher = vi.fn<typeof fetch>();
  bodies.forEach((body) => fetcher.mockResolvedValueOnce(response(body)));
  return { fetcher, provider: new ReapProvider(config(), fetcher) };
}

describe("real API catalog contracts", () => {
  test("maps search filters, cursor, headers, and native decimal amounts without losing precision", async () => {
    const { fetcher, provider } = setup(search);
    const result = await provider.search({ query: "coffee", country: "US", currency: "USD", limit: 2, merchant: "Coffee Merchant", max_item_price: "25.00", cursor: "page-1" });
    expect(result.products[0]?.price_range.min).toEqual({ amount: "19.99", currency: "USD" });
    expect(result.next_cursor).toBe("page-2");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://sg.sandbox.api.reap.global/agentic/products/search");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-only-key", "Reap-Version": "2025-02-14" });
    expect(JSON.parse(String(init?.body))).toMatchObject({ context: { country: "US", currency: "USD" },
      merchantPreference: { mode: "ONLY", merchantName: "Coffee Merchant" }, filters: { price: { max: "25.00" } }, pagination: { limit: 2, cursor: "page-1" } });
  });
  test("details and variant resolution preserve option IDs and unknown shipping requirements", async () => {
    const { provider, fetcher } = setup(details, variant);
    const found = await provider.details("product-1");
    expect(found.options[0]?.values[0]?.option_id).toBe("ground");
    expect(found.default_variant.requires_shipping).toBeNull();
    expect(await provider.variant("product-1", ["ground"])).toMatchObject({ id: "variant-1", available: true });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ productId: "product-1", optionIds: ["ground"] });
  });
  test("refuses unresolved products and malformed monetary data", async () => {
    const { provider } = setup({ products: [], errors: [{ productId: "missing", code: "NOT_FOUND" }] }, { ...search, products: [{ ...product, priceRange: { min: { amount: "19.99", currency: "USD" }, max: amount() } }] });
    await expect(provider.details("missing")).rejects.toMatchObject({ code: "PRODUCT_UNAVAILABLE" });
    await expect(provider.search({ query: "coffee", country: "US", currency: "USD", limit: 1 })).rejects.toMatchObject({ code: "UPSTREAM_CONTRACT_ERROR" });
  });
});

describe("payment API contracts with stubbed HTTP only", () => {
  test("builds exact enrollment, quote and shipping requests without model-controlled approval", () => {
    const provider = new ReapProvider(config());
    expect(JSON.parse(provider.enrollmentRequest("owner", "test@example.test", "https://callback.example/callback").body)).toEqual({ source: "EXTERNAL", owner: { type: "CLIENT_REFERENCE", id: "owner", email: "test@example.test" }, presentation: { type: "REDIRECT", returnUrl: "https://callback.example/callback" } });
    const request = provider.quoteRequest({ variant_id: "variant-1", quantity: 1, currency: "USD", email: "test@example.test", offer_code: null,
      delivery: { recipient_name: "Test User", first_name: "Test", last_name: "User", phone: "+12025550123", line1: "1 Test St", city: "Test", postal_code: "10001", country: "US" } });
    expect(JSON.parse(request.body)).toMatchObject({ items: [{ variantId: "variant-1", quantity: 1 }], shippingAddress: { firstName: "Test", lastName: "User", phone: "+12025550123", addressLine1: "1 Test St" } });
    expect(JSON.parse(provider.shippingRequest("quote-1", "standard").body)).toEqual({ shippingOptionId: "standard" });
    expect(() => provider.checkoutRequest("quote-1", "enrollment-1", "https://callback.example")).toThrow(/disabled/);
  });
  test("reads enrollment, quote and completed checkout without deriving completion from callbacks", async () => {
    const { provider, fetcher } = setup(
      { id: "enrollment-1", status: "ACTIVE", owner: { type: "CLIENT_REFERENCE", id: "owner" }, nextAction: null, paymentMethod: { network: "VISA", last4: "4242" } },
      quote, { id: "checkout-1", status: "COMPLETED", quoteId: "quote-1", enrollmentId: "enrollment-1", nextAction: null, orderId: "order-1", finalAmount: amount(23.99) });
    expect(await provider.enrollment("enrollment-1")).toMatchObject({ status: "ACTIVE", masked_label: "VISA ending 4242" });
    expect(await provider.quote("quote-1")).toMatchObject({ breakdown: { final_amount: { amount: "23.99", currency: "USD" } } });
    expect(await provider.checkout("checkout-1")).toMatchObject({ status: "COMPLETED", order_reference: "order-1", final_amount: { amount: "23.99", currency: "USD" } });
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  test("create checkout uses the durable key and preserves the hosted approval step", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "checkout-1", status: "REQUIRES_ACTION", quoteId: "quote-1", enrollmentId: "enrollment-1",
      amount: amount(23.99), nextAction: { type: "REDIRECT", url: "https://approval.example/approve", expiresAt: "2030-01-01T00:00:00Z" } }));
    const provider = new ReapProvider(config({ REAP_CHECKOUT_ENABLED: "true", REAP_RETURN_URL_CONFIRMED: "true", REAP_PER_PURCHASE_APPROVAL_CONFIRMED: "true", REAP_APPROVAL_VERIFICATION_REF: "test-contract" }), fetcher);
    const result = await provider.execute(provider.checkoutRequest("quote-1", "enrollment-1", "https://callback.example"), "stable-key");
    expect(result).toMatchObject({ kind: "checkout", value: { status: "REQUIRES_ACTION", next_action: { url: "https://approval.example/approve" }, final_amount: null } });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "Idempotency-Key": "stable-key" });
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty("X-Simulate-Checkout");
  });
  test.each([[401, "UNAUTHORIZED", "REAP_AUTH_FAILED"], [403, "AGENTIC_PAYMENTS_NOT_ENABLED", "REAP_FEATURE_NOT_ENABLED"], [400, "QUOTE_EXPIRED", "QUOTE_EXPIRED"]])("maps %s/%s safely", async (status, code, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: { code, detail: "private-upstream-data" } }, Number(status)));
    await expect(new ReapProvider(config(), fetcher).checkout("checkout-1")).rejects.toMatchObject({ code: expected });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("checkout gates without network access", () => {
  const enabled = { REAP_CHECKOUT_ENABLED: "true", REAP_RETURN_URL_CONFIRMED: "true",
    REAP_PER_PURCHASE_APPROVAL_CONFIRMED: "true", REAP_APPROVAL_VERIFICATION_REF: "test-contract" };

  test.each([
    { REAP_CHECKOUT_ENABLED: "false" }, { REAP_MONEY_UNIT: "unverified" }, { REAP_RETURN_URL_CONFIRMED: "false" },
    { REAP_HOSTED_URL_HOSTS: "" }, { REAP_PER_PURCHASE_APPROVAL_CONFIRMED: "false" }, { REAP_APPROVAL_VERIFICATION_REF: "" },
  ])("enforces every prerequisite during commerce, request construction, and replay: %j", async (override) => {
    const settings = config({ ...enabled, ...override });
    const fetcher = vi.fn<typeof fetch>();
    const provider = new ReapProvider(settings, fetcher);
    const db = new Database(settings);
    const request: ProviderRequest = { kind: "checkout", method: "POST", path: "/agentic/checkouts", body: "{}", headers: { "Reap-Version": settings.reap.version } };
    try {
      expect(() => new Commerce(db, provider, settings).assertSandboxCheckout()).toThrow(expect.objectContaining({ code: "REAP_FEATURE_NOT_ENABLED" }));
      expect(() => provider.checkoutRequest("quote-1", "enrollment-1", "https://callback.example")).toThrow(expect.objectContaining({ code: "REAP_FEATURE_NOT_ENABLED" }));
      await expect(provider.execute(request, "stable-key")).rejects.toMatchObject({ code: "REAP_FEATURE_NOT_ENABLED" });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await db.close(); }
  });

  test("current simulation settings never authorize replay of a non-simulated request", async () => {
    const settings = config({ ...enabled, SANDBOX_SIMULATE_CHECKOUT: "true", REAP_PER_PURCHASE_APPROVAL_CONFIRMED: "false", REAP_APPROVAL_VERIFICATION_REF: "" });
    const fetcher = vi.fn<typeof fetch>();
    const provider = new ReapProvider(settings, fetcher);
    const request = provider.checkoutRequest("quote-1", "enrollment-1", "https://callback.example");
    expect(request.headers["X-Simulate-Checkout"]).toBe("COMPLETED");
    delete request.headers["X-Simulate-Checkout"];
    await expect(provider.execute(request, "original-real-request-key")).rejects.toMatchObject({ code: "REAP_FEATURE_NOT_ENABLED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("read-only sandbox checker", () => {
  test("checks search/details/explicit variant without any payment writes", async () => {
    const { fetcher } = setup(search, details, variant);
    const result = await checkSandbox(config(), { query: "coffee", country: "US", currency: "USD", product_id: "product-1", option_ids: ["ground"] }, fetcher);
    expect(result.verified).toEqual(["search", "details", "variant"]);
    expect(result.purchase_flow.status).toBe("NOT_TESTED");
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/agentic/products/search", "/agentic/products/details", "/agentic/products/variant"]);
    expect(JSON.stringify(result)).not.toContain("test-only-key");
  });
  test("does not invent option selections or report an empty catalog as a purchase test", async () => {
    const { fetcher } = setup({ products: [], warnings: [], pagination: { nextCursor: null } });
    const result = await checkSandbox(config(), { query: "none", country: "US", currency: "USD" }, fetcher);
    expect(result.verified).toEqual(["search"]);
    expect(result.details).toBeNull();
    expect(result.variant).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test("refuses mock configuration and unsupported regions before network access", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(checkSandbox(config({ APP_MODE: "mock" }), {}, fetcher)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(checkSandbox(config(), { query: "coffee", country: "SG", currency: "USD" }, fetcher)).rejects.toMatchObject({ code: "UNSUPPORTED_REGION_OR_MERCHANT" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  test("accepts a page-size flag and reports unknown flags as a usage error", async () => {
    expect(parseCheckArgs(["--query", "coffee", "--limit", "3"])).toMatchObject({ query: "coffee", limit: "3" });
    expect(() => parseCheckArgs(["--page-size", "3"])).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    const { fetcher } = setup(search, details);
    await checkSandbox(config(), { query: "coffee", country: "US", currency: "USD", limit: 3 }, fetcher);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ pagination: { limit: 3 } });
  });
});
