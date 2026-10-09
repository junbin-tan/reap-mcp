import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, test, vi } from "vitest";
import { Commerce } from "../../src/commerce.js";
import { loadConfig } from "../../src/config.js";
import { Database } from "../../src/db.js";
import { createHttpApp } from "../../src/http.js";
import { buildMcpServer } from "../../src/mcp.js";
import { MockProvider } from "../../src/providers/mock.js";
import { localIdentity } from "../../src/runtime.js";
import { inputSchemas, outputSchemas, type Envelope, type ToolName } from "../../src/schemas.js";

const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const config = loadConfig({ DATABASE_URL: "postgresql://test:test@127.0.0.1/test", DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), PURCHASE_CAPS: '{"USD":"100.00"}' });
  const db = new Database(config);
  close.push(() => db.close());
  const identity = localIdentity(config);
  vi.spyOn(db, "actor").mockResolvedValue({ ...identity, id: randomUUID(), ownerReference: "owner" });
  vi.spyOn(db, "rateLimit").mockResolvedValue();
  vi.spyOn(db, "audit").mockResolvedValue();
  vi.spyOn(db, "query").mockImplementation(async () => [{ id: randomUUID() }] as never);
  const commerce = new Commerce(db, new MockProvider(db, config), config);
  const server = buildMcpServer(commerce, identity);
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(() => server.close(), () => client.close());
  return { client, commerce, identity };
}

test("MCP discovery publishes all five strict contracts and consequential-tool hints", async () => {
  const { client } = await fixture();
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(Object.keys(inputSchemas));
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.outputSchema?.type).toBe("object");
    expect(tool.annotations?.readOnlyHint).toBe(["search_products", "get_purchase_status"].includes(tool.name));
    expect(tool.annotations?.destructiveHint).toBe(tool.name === "request_purchase");
  }
});

test("text-only MCP clients receive the complete search result, including product IDs and prices", async () => {
  const { client } = await fixture();
  await client.listTools();
  const result = await client.callTool({ name: "search_products", arguments: { query: "coffee", country: "US", currency: "USD" } });
  expect(result.isError).toBe(false);
  const structured = outputSchemas.search_products.parse(result.structuredContent);
  expect(structured.data).toMatchObject({ products: expect.any(Array) });
  const json = result.content.find((entry) => entry.type === "text" && entry.text.startsWith("{"));
  expect(json?.type).toBe("text");
  if (json?.type === "text") expect(JSON.parse(json.text)).toEqual(structured);
});

test.each(Object.keys(inputSchemas) as ToolName[])("%s reports validation errors as tool errors", async (name) => {
  const { client } = await fixture();
  await client.listTools();
  const result = await client.callTool({ name, arguments: { unexpected: true } });
  expect(result.isError).toBe(true);
  expect(outputSchemas[name].parse(result.structuredContent)).toMatchObject({ ok: false, status: "INVALID_INPUT" });
});

test("unknown tools return a controlled error without dispatching commerce", async () => {
  const { client, commerce } = await fixture();
  const call = vi.spyOn(commerce, "call");
  const result = await client.callTool({ name: "buy_now", arguments: {} });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ status: "UNKNOWN_TOOL" });
  expect(call).not.toHaveBeenCalled();
});

test("local callback pages explain stdio usage and never enable unauthenticated HTTP MCP", async () => {
  const { commerce } = await fixture();
  const http = createHttpApp(commerce, { remote: false });
  const server = http.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  close.push(() => http.close(), () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  commerce.config.publicUrl = new URL(base);
  commerce.config.origins = [base];
  const page = await fetch(base);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("The HTTP /mcp endpoint is disabled in this process.");
  const mcp = await fetch(`${base}/mcp`);
  expect(mcp.status).toBe(503);
  expect(await mcp.json()).toMatchObject({ error: "remote_mcp_disabled" });
});

test("Commerce rejects missing scopes without database activity", async () => {
  const { commerce, identity } = await fixture();
  const result: Envelope = await commerce.call("request_purchase", {}, { ...identity, scopes: [] });
  expect(result.status).toBe("FORBIDDEN");
  expect(commerce.db.actor).not.toHaveBeenCalled();
});
