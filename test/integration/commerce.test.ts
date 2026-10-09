import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { Commerce } from "../../src/commerce.js";
import { loadConfig, loopback, type Config } from "../../src/config.js";
import { Database } from "../../src/db.js";
import { createHttpApp } from "../../src/http.js";
import { buildMcpServer } from "../../src/mcp.js";
import { MockProvider } from "../../src/providers/mock.js";
import { localIdentity } from "../../src/runtime.js";
import { outputSchemas, purchaseDataSchema, paymentDataSchema, searchDataSchema, type ToolName } from "../../src/schemas.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("Set TEST_DATABASE_URL to a dedicated local PostgreSQL test database; the application database is never used implicitly.");
const url = new URL(testUrl);
if (!loopback.has(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Integration tests require a local database with test in its name.");
const schema = `mcp_test_${randomUUID().replaceAll("-", "")}`;
const key = randomBytes(32).toString("base64");
const databases: Database[] = [];
const cleanups: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  const pool = new Pool({ connectionString: testUrl });
  try { await pool.query(`CREATE SCHEMA ${schema}`); } finally { await pool.end(); }
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = database();
  await db.migrate();
});
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
afterAll(async () => { await Promise.all(databases.map((db) => db.close())); });

function database(scenario: Config["mockScenario"] = "success") {
  const config = loadConfig({ APP_MODE: "mock", DATABASE_URL: url.href, DATA_ENCRYPTION_KEY: key,
    PURCHASE_CAPS: '{"USD":"100.00"}', MOCK_SCENARIO: scenario, LOCAL_DEMO_SUBJECT: randomUUID() });
  const db = new Database(config);
  databases.push(db);
  return db;
}

async function fixture(scenario: Config["mockScenario"] = "success") {
  const db = database(scenario);
  const provider = new MockProvider(db, db.config);
  const commerce = new Commerce(db, provider, db.config);
  const identity = localIdentity(db.config);
  const server = buildMcpServer(commerce, identity);
  const client = new Client({ name: "integration-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  await client.listTools();
  cleanups.push(() => server.close(), () => client.close());
  const call = async (name: ToolName, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const parsed = outputSchemas[name].parse(result.structuredContent);
    expect(result.isError).toBe(!parsed.ok);
    return parsed;
  };
  const consent = async (link: string, kind: "enrollment" | "checkout", approved = true) => {
    const callback = await provider.consent(new URL(link).pathname.split("/").at(-1)!, kind, approved);
    return commerce.callback(new URL(callback).searchParams.get("ref")!, kind === "enrollment" ? "payment-method" : "purchase");
  };
  const connect = async () => {
    const pending = paymentDataSchema.parse((await call("connect_payment_method")).data);
    expect(pending.enrollment_status).toBe("REQUIRES_ACTION");
    await consent(pending.setup_url!, "enrollment");
    const active = paymentDataSchema.parse((await call("connect_payment_method", { payment_method_id: pending.payment_method_id })).data);
    expect(active.enrollment_status).toBe("ACTIVE");
    return active;
  };
  const create = async (overrides: Record<string, unknown> = {}) => {
    const search = searchDataSchema.parse((await call("search_products", { query: "mug", country: "US", currency: "USD" })).data);
    const input = { action: "create", product_id: search.products[0]!.product_id, quantity: 1, country: "US", currency: "USD", operation_key: randomUUID(),
      shipping_address: { recipient_name: "Test User", line1: "1 Test St", city: "Test", postal_code: "10001", country: "US" }, ...overrides };
    return { input, result: await call("prepare_purchase", input) };
  };
  return { db, provider, commerce, identity, client, call, consent, connect, create };
}

test("all five MCP calls complete an approval-gated purchase with shipping and stable retries", async () => {
  const f = await fixture();
  const method = await f.connect();
  const { input, result } = await f.create();
  expect(result.status).toBe("READY");
  const draft = purchaseDataSchema.parse(result.data);
  expect((await f.call("prepare_purchase", input)).data).toEqual(result.data);
  const shippingInput = { action: "select_shipping", purchase_id: draft.purchase_id, expected_revision: draft.revision, shipping_option_id: "express" };
  const updated = purchaseDataSchema.parse((await f.call("prepare_purchase", shippingInput)).data);
  expect(updated.revision).toBe(draft.revision + 1);
  expect(updated.quote?.breakdown.final_amount.amount).toBe("21.00");
  expect((await f.call("prepare_purchase", shippingInput)).data).toEqual(updated);
  const request = { purchase_id: updated.purchase_id, payment_method_id: method.payment_method_id, expected_revision: updated.revision };
  const checkout = purchaseDataSchema.parse((await f.call("request_purchase", request)).data);
  expect(checkout.state).toBe("REQUIRES_ACTION");
  expect(checkout.charged_amount).toBeNull();
  expect((await f.call("request_purchase", request)).data).toEqual(checkout);
  await f.consent(checkout.approval_url!, "checkout");
  const completed = purchaseDataSchema.parse((await f.call("get_purchase_status", { purchase_id: draft.purchase_id })).data);
  expect(completed).toMatchObject({ state: "COMPLETED", reconciliation_required: false, charged_amount: { amount: "21.00", currency: "USD" } });
  expect(completed.order_reference).toMatch(/^MOCK-/);
  expect(await f.db.query("SELECT kind FROM operations WHERE purchase_id=$1 AND kind='checkout'", [draft.purchase_id])).toHaveLength(1);
});

test("search pagination binds cursors to criteria and users, and missing options/address never creates a quote", async () => {
  const f = await fixture();
  const criteria = { query: "coffee", country: "US", currency: "USD", limit: 1 };
  const first = searchDataSchema.parse((await f.call("search_products", criteria)).data);
  expect(first.next_cursor).not.toBeNull();
  const second = searchDataSchema.parse((await f.call("search_products", { ...criteria, cursor: first.next_cursor })).data);
  expect(second.products[0]?.product_id).not.toBe(first.products[0]?.product_id);
  expect((await f.call("search_products", { ...criteria, query: "mug", cursor: first.next_cursor })).status).toBe("INVALID_CURSOR");
  expect((await f.commerce.call("search_products", { ...criteria, cursor: first.next_cursor }, { ...f.identity, subject: randomUUID() })).status).toBe("INVALID_CURSOR");
  const input = { action: "create", product_id: first.products[0]!.product_id, quantity: 1, country: "US", currency: "USD", operation_key: randomUUID() };
  expect((await f.call("prepare_purchase", input)).status).toBe("NEEDS_INPUT");
  expect((await f.call("prepare_purchase", { ...input, option_ids: ["whole"] })).status).toBe("NEEDS_INPUT");
  expect((await f.call("prepare_purchase", { ...input, option_ids: ["sold-out"] })).status).toBe("PRODUCT_UNAVAILABLE");
  expect(await f.db.query("SELECT id FROM purchases WHERE operation_key=$1", [input.operation_key])).toHaveLength(0);
});

test("search reports each omitted-image warning once per page", async () => {
  const f = await fixture();
  const original = f.provider.search.bind(f.provider);
  vi.spyOn(f.provider, "search").mockImplementation(async (input) => {
    const found = await original(input);
    return { ...found, products: found.products.map((product) => ({ ...product, image_url: "https://images.example/item.png" })) };
  });
  const data = searchDataSchema.parse((await f.call("search_products", { query: "coffee", country: "US", currency: "USD", limit: 5 })).data);
  expect(data.products.length).toBeGreaterThan(1);
  expect(data.products.every((product) => product.image_url === null)).toBe(true);
  expect(data.warnings.filter((warning) => warning.includes("image URL"))).toHaveLength(1);
});

test("stale revisions, budgets, inactive enrollment and other owners cannot start checkout", async () => {
  const f = await fixture();
  const inactive = paymentDataSchema.parse((await f.call("connect_payment_method")).data);
  const { input, result } = await f.create({ max_total: "1.00" });
  const draft = purchaseDataSchema.parse(result.data);
  const request = { purchase_id: draft.purchase_id, payment_method_id: inactive.payment_method_id, expected_revision: draft.revision };
  expect((await f.call("request_purchase", { ...request, expected_revision: draft.revision + 1 })).status).toBe("REVISION_MISMATCH");
  expect((await f.call("request_purchase", request)).status).toBe("PAYMENT_METHOD_NOT_ACTIVE");
  await f.consent(inactive.setup_url!, "enrollment");
  expect((await f.call("request_purchase", request)).status).toBe("BUDGET_EXCEEDED");
  expect((await f.call("prepare_purchase", { ...input, quantity: 2 })).status).toBe("IDEMPOTENCY_CONFLICT");
  expect((await f.commerce.call("get_purchase_status", { purchase_id: draft.purchase_id }, { ...f.identity, subject: randomUUID() })).status).toBe("FORBIDDEN");
  expect(await f.db.query("SELECT id FROM operations WHERE purchase_id=$1 AND kind='checkout'", [draft.purchase_id])).toHaveLength(0);
});

test.each(["decline", "expired_quote", "changed_price", "unknown_status", "missing_receipt"] as const)("purchase scenario %s retains its truthful outcome", async (scenario) => {
  const f = await fixture(scenario);
  const method = await f.connect();
  const draft = purchaseDataSchema.parse((await f.create()).result.data);
  const request = { purchase_id: draft.purchase_id, payment_method_id: method.payment_method_id, expected_revision: draft.revision };
  const result = await f.call("request_purchase", request);
  if (scenario === "expired_quote") {
    expect(draft.state).toBe("EXPIRED");
    expect(result.ok).toBe(false);
    expect(await f.db.query("SELECT id FROM operations WHERE purchase_id=$1 AND kind='checkout'", [draft.purchase_id])).toHaveLength(0);
    return;
  }
  if (scenario === "changed_price") {
    expect(result.status).toBe("REVIEW_REQUIRED");
    const revised = purchaseDataSchema.parse(result.data);
    expect(revised.revision).toBe(draft.revision + 1);
    expect(await f.db.query("SELECT id FROM operations WHERE purchase_id=$1 AND kind='checkout'", [draft.purchase_id])).toHaveLength(0);
    return;
  }
  const checkout = purchaseDataSchema.parse(result.data);
  await f.consent(checkout.approval_url!, "checkout");
  const final = purchaseDataSchema.parse((await f.call("get_purchase_status", { purchase_id: draft.purchase_id })).data);
  expect(final.state).toBe(scenario === "decline" ? "FAILED" : scenario === "unknown_status" ? "UNKNOWN_RECONCILIATION_REQUIRED" : "COMPLETED");
  expect(final.reconciliation_required).toBe(scenario !== "decline");
  if (scenario === "missing_receipt") expect(final.order_reference).toBeNull();
});

test("lost checkout response recovers the same durable key; status reads never replay writes", async () => {
  const f = await fixture("lost_response");
  const method = await f.connect();
  const draft = purchaseDataSchema.parse((await f.create()).result.data);
  const execute = vi.spyOn(f.provider, "execute");
  const request = { purchase_id: draft.purchase_id, payment_method_id: method.payment_method_id, expected_revision: draft.revision };
  expect((await f.call("request_purchase", request)).status).toBe("UPSTREAM_UNAVAILABLE");
  expect((await f.call("get_purchase_status", { purchase_id: draft.purchase_id })).status).toBe("UNKNOWN_RECONCILIATION_REQUIRED");
  expect(execute).toHaveBeenCalledTimes(1);
  await f.db.query("UPDATE operations SET next_attempt_at=now() WHERE purchase_id=$1 AND kind='checkout'", [draft.purchase_id]);
  const recovered = await f.call("request_purchase", request);
  expect(recovered.status).toBe("REQUIRES_ACTION");
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]?.[1]).toBe(execute.mock.calls[1]?.[1]);
  expect(await f.db.query("SELECT id FROM operations WHERE purchase_id=$1 AND kind='checkout'", [draft.purchase_id])).toHaveLength(1);
});

test("concurrent purchase requests create at most one checkout", async () => {
  const f = await fixture();
  const method = await f.connect();
  const draft = purchaseDataSchema.parse((await f.create()).result.data);
  const input = { purchase_id: draft.purchase_id, payment_method_id: method.payment_method_id, expected_revision: draft.revision };
  const results = await Promise.all([f.call("request_purchase", input), f.call("request_purchase", input)]);
  expect(results.some((result) => result.status === "REQUIRES_ACTION")).toBe(true);
  expect(results.every((result) => ["REQUIRES_ACTION", "OPERATION_PENDING"].includes(result.status))).toBe(true);
  expect(await f.db.query("SELECT id FROM operations WHERE purchase_id=$1 AND kind='checkout'", [draft.purchase_id])).toHaveLength(1);
});

test("mock hosted pages enforce CSRF, verify callbacks and keep remote MCP disabled", async () => {
  const f = await fixture();
  const http = createHttpApp(f.commerce, { remote: false });
  const server = http.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.db.config.publicUrl = new URL(base);
  f.db.config.origins = [base];
  cleanups.push(() => http.close(), () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const method = paymentDataSchema.parse((await f.call("connect_payment_method")).data);
  expect((await fetch(`${base}/mcp`)).status).toBe(503);
  expect((await fetch(`${base}/callbacks/payment-method?ref=invalid`)).status).toBe(403);
  const page = await fetch(method.setup_url!);
  expect(page.status).toBe(200);
  const cookie = page.headers.getSetCookie()[0]!.split(";")[0]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
  expect((await fetch(method.setup_url!, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, Cookie: cookie }, body: "decision=approve&csrf=invalid" })).status).toBe(403);
  const approved = await fetch(method.setup_url!, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, Cookie: cookie }, body: new URLSearchParams({ decision: "approve", csrf }) });
  expect(approved.status).toBe(303);
  const callback = await fetch(approved.headers.get("location")!);
  expect(await callback.text()).toContain("Card connected");
  expect((await f.call("connect_payment_method", { payment_method_id: method.payment_method_id })).status).toBe("ACTIVE");
});
