import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { Config } from "../config.js";
import { Database } from "../db.js";
import type { Checkout, Details, Enrollment, Provider, ProviderRequest, ProviderResult, Quote, QuoteRequest, SearchRequest, SearchResponse, Variant } from "../domain.js";
import { AppError, contract } from "../errors.js";
import { currencyDigits, money } from "../money.js";
import { canonical, hash, opaqueToken } from "../security.js";

interface StoredResource {
  kind: "enrollment" | "quote" | "checkout";
  value: Enrollment | Quote | Checkout;
  scenario: Config["mockScenario"];
  callback: string | null;
  quote: Quote | null;
  price_changed: boolean;
  reads: number;
}
const merchant = "Mock Coffee Roasters";
const catalog = [
  { id: "mock-beans", name: "Mock Coffee Beans", price: "18.50", options: true },
  { id: "mock-mug", name: "Mock Ceramic Coffee Mug", price: "12.00", options: false },
];

export class MockProvider implements Provider {
  constructor(private readonly db: Database, private readonly config: Config) {}

  private build(kind: ProviderRequest["kind"], path: string, body: unknown): ProviderRequest {
    return { kind, method: "POST", path, body: JSON.stringify(body), headers: { "Mock-Scenario": this.config.mockScenario } };
  }
  enrollmentRequest(owner: string, email: string, callback: string): ProviderRequest {
    return this.build("enrollment", "/agentic/enrollments", { source: "EXTERNAL", owner: { type: "CLIENT_REFERENCE", id: owner, email }, presentation: { type: "REDIRECT", returnUrl: callback } });
  }
  quoteRequest(input: QuoteRequest): ProviderRequest { return this.build("quote", "/agentic/quotes", input); }
  shippingRequest(id: string, optionId: string): ProviderRequest { return this.build("shipping", `/agentic/quotes/${id}/shipping-option`, { shippingOptionId: optionId }); }
  checkoutRequest(quoteId: string, enrollmentId: string, callback: string): ProviderRequest {
    return this.build("checkout", "/agentic/checkouts", { quoteId, enrollmentId, presentation: { type: "REDIRECT", returnUrl: callback } });
  }

  async search(input: SearchRequest): Promise<SearchResponse> {
    if (this.config.mockScenario === "rate_limit" && await this.firstFault(`search:${hash(canonical(input))}`)) {
      throw new AppError("UPSTREAM_RATE_LIMITED", "Mock rate limit. Wait briefly and repeat the same search.", true);
    }
    const offset = input.cursor ? Number(input.cursor) : 0;
    contract(Number.isSafeInteger(offset) && offset >= 0);
    const hits = catalog.filter((item) => item.name.toLowerCase().includes(input.query.toLowerCase()) && (!input.merchant || input.merchant === merchant));
    const selected = hits.slice(offset, offset + input.limit);
    return {
      products: selected.map((item) => ({ id: item.id, name: item.name, merchant, available: true, image_url: null,
        price_range: { min: money(item.price, input.currency), max: money(item.price, input.currency) },
        preview_variant: this.fixtureVariant(item.id, "whole", input.currency) })),
      warnings: ["This is a deterministic mock catalog. Prices and fulfillment are simulated."],
      next_cursor: offset + selected.length < hits.length ? String(offset + selected.length) : null,
    };
  }

  async details(id: string): Promise<Details> {
    const item = catalog.find((entry) => entry.id === id);
    if (!item) throw new AppError("PRODUCT_UNAVAILABLE", "The mock product is unavailable. Search again.");
    return { id, name: item.name, merchant,
      options: item.options ? [{ name: "Grind", values: [
        { option_id: "whole", label: "Whole beans", available: true },
        { option_id: "ground", label: "Ground coffee", available: true },
        { option_id: "sold-out", label: "Espresso grind", available: false },
      ] }] : [], default_variant: this.fixtureVariant(id, "whole", this.config.currencies[0] ?? "USD") };
  }

  async variant(id: string, options: string[]): Promise<Variant> {
    if (options.length !== 1 || !["whole", "ground", "sold-out"].includes(options[0] ?? "")) throw new AppError("INVALID_INPUT", "Select exactly one of the mock grind options.");
    return this.fixtureVariant(id, options[0] ?? "whole", this.config.currencies[0] ?? "USD");
  }

  private fixtureVariant(id: string, option: string, currency: string): Variant {
    const item = catalog.find((entry) => entry.id === id);
    if (!item) throw new AppError("PRODUCT_UNAVAILABLE", "Choose a product from the mock catalog.");
    return { id: `${id}:${option}`, name: item.options ? (option === "ground" ? "Ground coffee" : "Whole beans") : "Standard mug",
      options: item.options ? [{ name: "Grind", value: option === "ground" ? "Ground coffee" : "Whole beans" }] : [],
      price: money(item.price, currency), available: option !== "sold-out", requires_shipping: true };
  }

  private async read(id: string): Promise<StoredResource> {
    const [row] = await this.db.query<{ data_ciphertext: string }>("SELECT data_ciphertext FROM mock_resources WHERE id=$1 AND namespace=$2", [id, this.config.namespace]);
    if (!row) throw new AppError("UPSTREAM_CONTRACT_ERROR", "The mock provider resource is unavailable.");
    return this.db.box.open<StoredResource>(row.data_ciphertext, `mock:${id}`);
  }
  private async save(resource: StoredResource): Promise<void> {
    await this.db.query("UPDATE mock_resources SET data_ciphertext=$2 WHERE id=$1 AND namespace=$3", [resource.value.id, this.db.box.seal(resource, `mock:${resource.value.id}`), this.config.namespace]);
  }

  async enrollment(id: string): Promise<Enrollment> {
    const stored = await this.read(id);
    contract(stored.kind === "enrollment");
    const value = stored.value as Enrollment;
    if (value.status === "REQUIRES_ACTION" && value.next_action?.expires_at && Date.parse(value.next_action.expires_at) <= Date.now()) {
      value.status = "EXPIRED";
      value.next_action = null;
      await this.save(stored);
    }
    return value;
  }
  async quote(id: string): Promise<Quote> {
    return this.db.locked(`mock:${id}`, async () => {
      const stored = await this.read(id);
      contract(stored.kind === "quote");
      const value = stored.value as Quote;
      if (stored.scenario === "changed_price" && !stored.price_changed) {
        value.breakdown.final_amount = money(new Decimal(value.breakdown.final_amount.amount).plus(1).toFixed(), value.breakdown.final_amount.currency);
        stored.price_changed = true;
        await this.save(stored);
      }
      return value;
    });
  }
  async checkout(id: string): Promise<Checkout> {
    return this.db.locked(`mock:${id}`, async () => {
      const stored = await this.read(id);
      contract(stored.kind === "checkout");
      const value = stored.value as Checkout;
      if (value.status === "REQUIRES_ACTION" && value.next_action?.expires_at && Date.parse(value.next_action.expires_at) <= Date.now()) {
        value.status = "EXPIRED";
        value.next_action = null;
      }
      if (value.status === "PROCESSING" && stored.reads++ > 0) {
        value.status = stored.scenario === "unknown_status" ? "UNRECOGNIZED_MOCK_STATUS" : "COMPLETED";
        value.order_reference = stored.scenario === "missing_receipt" ? null : `MOCK-${id.slice(0, 8)}`;
        value.final_amount = stored.scenario === "missing_receipt" ? null : stored.quote?.breakdown.final_amount ?? null;
      }
      await this.save(stored);
      return value;
    });
  }

  async execute(request: ProviderRequest, key: string): Promise<ProviderResult> {
    return this.db.locked(`mock-idempotency:${key}`, async (client) => {
      const requestHash = hash(canonical(request));
      const [cached] = await this.db.query<{ request_hash: string; response_ciphertext: string }>("SELECT * FROM mock_replays WHERE namespace=$1 AND idempotency_key=$2", [this.config.namespace, key], client);
      if (cached) {
        contract(cached.request_hash === requestHash);
        return this.db.box.open<ProviderResult>(cached.response_ciphertext, `mock-replay:${key}`);
      }
      const scenario = request.headers["Mock-Scenario"] as Config["mockScenario"];
      const id = randomUUID();
      const token = opaqueToken();
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const body = JSON.parse(request.body) as Record<string, unknown>;
      let stored: StoredResource;
      if (request.kind === "enrollment") {
        const owner = body.owner as { id: string };
        const presentation = body.presentation as { returnUrl: string };
        stored = { kind: "enrollment", scenario, callback: presentation.returnUrl, quote: null, price_changed: false, reads: 0,
          value: { id, status: "REQUIRES_ACTION", owner_reference: owner.id, masked_label: null,
            next_action: { url: new URL(`/mock/enrollment/${token}`, this.config.publicUrl).href, expires_at: expiresAt } } };
      } else if (request.kind === "quote") {
        const input = JSON.parse(request.body) as QuoteRequest;
        const item = catalog.find((entry) => input.variant_id.startsWith(`${entry.id}:`));
        contract(item);
        const subtotal = money(new Decimal(item.price).times(input.quantity).toFixed(), input.currency);
        const discount = input.offer_code === "SAVE10" ? money(new Decimal(subtotal.amount).times("0.10").toFixed(currencyDigits(input.currency)), input.currency) : null;
        const final = money(new Decimal(subtotal.amount).plus(4).minus(discount?.amount ?? 0).toFixed(), input.currency);
        const quote: Quote = { id, expires_at: scenario === "expired_quote" ? new Date(Date.now() - 1000).toISOString() : expiresAt,
          shipping_options: [
            { id: "standard", name: "Mock standard shipping", selected: true, price: money("4", input.currency), details: [] },
            { id: "express", name: "Mock express shipping", selected: false, price: money("9", input.currency), details: [] },
          ],
          breakdown: { items_subtotal: subtotal, shipping: money("4", input.currency),
            tax: { amount: money("1", input.currency), included_in_prices: true },
            discounts: discount ? [{ name: "SAVE10", amount: discount }] : [], additional_charges: [], final_amount: final },
          raw_amounts: { final_amount: final.amount },
        };
        stored = { kind: "quote", value: quote, scenario, callback: null, quote: null, price_changed: false, reads: 0 };
      } else if (request.kind === "shipping") {
        const quoteId = request.path.split("/")[3];
        contract(quoteId);
        const original = await this.read(quoteId);
        contract(original.kind === "quote");
        const quote = structuredClone(original.value as Quote);
        if (Date.parse(quote.expires_at) <= Date.now()) throw new AppError("QUOTE_EXPIRED", "The mock quote expired. Prepare a new draft.");
        const option = quote.shipping_options.find((entry) => entry.id === body.shippingOptionId);
        if (!option) throw new AppError("INVALID_INPUT", "Choose one of the quoted shipping options.");
        const total = new Decimal(quote.breakdown.final_amount.amount).minus(quote.breakdown.shipping?.amount ?? 0).plus(option.price.amount);
        quote.id = id;
        quote.shipping_options.forEach((entry) => { entry.selected = entry.id === option.id; });
        quote.breakdown.shipping = option.price;
        quote.breakdown.final_amount = money(total.toFixed(), option.price.currency);
        stored = { ...original, value: quote, price_changed: true };
      } else {
        const enrollment = await this.enrollment(String(body.enrollmentId));
        const quoted = await this.read(String(body.quoteId));
        contract(quoted.kind === "quote");
        const quote = quoted.value as Quote;
        if (enrollment.status !== "ACTIVE") throw new AppError("PAYMENT_METHOD_NOT_ACTIVE", "Complete mock enrollment before requesting checkout.");
        if (Date.parse(quote.expires_at) <= Date.now()) throw new AppError("QUOTE_EXPIRED", "The mock quote expired. Prepare a new draft.");
        stored = { kind: "checkout", scenario, quote, callback: (body.presentation as { returnUrl: string }).returnUrl, reads: 0, price_changed: false,
          value: { id, status: "REQUIRES_ACTION", quote_id: quote.id, enrollment_id: enrollment.id, final_amount: null, order_reference: null,
            next_action: { url: new URL(`/mock/approval/${token}`, this.config.publicUrl).href, expires_at: expiresAt } } };
      }
      const response = { kind: stored.kind, value: stored.value } as ProviderResult;
      await this.db.transaction(async (tx) => {
        await tx.query("INSERT INTO mock_resources (id,namespace,kind,data_ciphertext,access_hash,expires_at) VALUES ($1,$2,$3,$4,$5,$6)", [id, this.config.namespace, stored.kind, this.db.box.seal(stored, `mock:${id}`), stored.kind === "quote" ? null : hash(token), expiresAt]);
        await tx.query("INSERT INTO mock_replays (namespace,idempotency_key,request_hash,response_ciphertext) VALUES ($1,$2,$3,$4)", [this.config.namespace, key, requestHash, this.db.box.seal(response, `mock-replay:${key}`)]);
      }, client);
      if (request.kind === "checkout" && scenario === "lost_response") throw new AppError("UPSTREAM_UNAVAILABLE", "Mock lost response after provider acceptance. The original operation must be recovered with its original key.", true, null, true);
      return response;
    });
  }

  async inspect(token: string, kind: "enrollment" | "checkout"): Promise<StoredResource> {
    const [row] = await this.db.query<{ id: string; expires_at: Date }>("SELECT id,expires_at FROM mock_resources WHERE namespace=$1 AND kind=$2 AND access_hash=$3", [this.config.namespace, kind, hash(token)]);
    if (!row || row.expires_at.getTime() <= Date.now()) throw new AppError("FORBIDDEN", "This mock approval link is invalid or expired.");
    return this.read(row.id);
  }

  async consent(token: string, kind: "enrollment" | "checkout", approve: boolean): Promise<string> {
    const initial = await this.inspect(token, kind);
    return this.db.locked(`mock:${initial.value.id}`, async () => {
      const stored = await this.inspect(token, kind);
      const value = stored.value as Enrollment | Checkout;
      if (value.status === "REQUIRES_ACTION") {
        value.status = kind === "enrollment" ? (approve ? "ACTIVE" : "FAILED") : (approve && stored.scenario !== "decline" ? "PROCESSING" : "FAILED");
        value.next_action = null;
        if (kind === "enrollment") (stored.value as Enrollment).masked_label = "Mock card ending 4242";
        await this.save(stored);
      }
      contract(stored.callback);
      return stored.callback;
    });
  }

  private async firstFault(key: string): Promise<boolean> {
    const [row] = await this.db.query<{ requests: number }>("INSERT INTO rate_windows (key,window_start,requests) VALUES ($1,'2000-01-01',1) ON CONFLICT (key,window_start) DO UPDATE SET requests=rate_windows.requests+1 RETURNING requests", [`mock-fault:${this.config.namespace}:${key}`]);
    return row?.requests === 1;
  }
}
