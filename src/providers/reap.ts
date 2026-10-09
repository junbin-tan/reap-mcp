import { setTimeout as sleep } from "node:timers/promises";
import { Decimal } from "decimal.js";
import { LosslessNumber, parse } from "lossless-json";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Checkout, Details, Enrollment, Provider, ProviderRequest, ProviderResult, Quote, QuoteRequest, Redirect, SearchRequest, SearchResponse, Variant } from "../domain.js";
import { AppError, contract } from "../errors.js";
import { currencyDigits, money, type Money } from "../money.js";
import { safeText, safeUrl } from "../security.js";

const text = z.string().min(1).max(8192);
const wireMoney = z.object({ amount: z.instanceof(LosslessNumber), currency: z.string().regex(/^[A-Z]{3}$/) });
const wireRedirect = z.object({ type: z.literal("REDIRECT"), url: text, expiresAt: z.string().optional() });
const wireVariant = z.object({
  id: text, name: z.string().optional(), options: z.array(z.object({ name: text, value: text })).max(30),
  price: wireMoney, available: z.boolean().optional(), requiresShipping: z.boolean().optional(),
});
const wireDetails = z.object({
  id: text, name: text, merchant: z.object({ name: text }),
  options: z.array(z.object({ name: text, values: z.array(z.object({ optionId: text, label: text, available: z.boolean().optional() })).max(100) })).max(20),
  defaultVariant: wireVariant,
});
const wireCharge = z.object({ name: z.string(), amount: wireMoney });
const wireQuote = z.object({
  id: text, expiresAt: text,
  shippingOptions: z.array(z.object({ id: text, name: text, selected: z.boolean(), price: wireMoney,
    details: z.array(z.object({ key: z.string(), value: z.string() })).max(30).optional() })).max(100),
  amountBreakdown: z.object({
    itemsSubtotal: wireMoney, shipping: wireMoney.optional(),
    tax: z.object({ amount: wireMoney, includedInPrices: z.boolean().optional() }).optional(),
    discounts: z.array(wireCharge).max(50), additionalCharges: z.array(wireCharge).max(50), finalAmount: wireMoney,
  }),
});
const wireEnrollment = z.object({
  id: text, status: text, owner: z.object({ type: z.literal("CLIENT_REFERENCE"), id: text }),
  nextAction: wireRedirect.nullable(),
  paymentMethod: z.object({ network: z.string().max(30).optional(), last4: z.string().regex(/^\d{4}$/).optional() }).nullish(),
});
const wireCheckout = z.object({
  id: text, status: text, quoteId: text.optional(), enrollmentId: text.nullable().optional(),
  nextAction: wireRedirect.nullable(), orderId: z.string().nullable().optional(), finalAmount: wireMoney.optional(),
});

export function retryDelay(value: string | null, now = Date.now()): number {
  if (!value) return 1000;
  const seconds = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 7 * 24 * 60 * 60 * 1000)) : 1000;
}

export class ReapProvider implements Provider {
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {}

  private unit(): "major" | "minor" {
    if (this.config.reap.moneyUnit === "unverified") throw new AppError("REAP_FEATURE_NOT_ENABLED", "Confirm Reap's monetary units for this project and set REAP_MONEY_UNIT before returning or using prices.");
    return this.config.reap.moneyUnit;
  }
  private amount(input: z.infer<typeof wireMoney>): Money {
    const raw = input.amount.value;
    contract(raw.length <= 80);
    const decimal = new Decimal(raw);
    contract(decimal.isFinite() && decimal.abs().lt("1e21"));
    return money(decimal.toFixed(), input.currency, this.unit());
  }
  private redirect(input: z.infer<typeof wireRedirect> | null): Redirect | null {
    if (!input) return null;
    if (input.expiresAt) contract(Number.isFinite(Date.parse(input.expiresAt)));
    return { url: safeUrl(input.url, this.config), expires_at: input.expiresAt ?? null };
  }
  private variantValue(input: z.infer<typeof wireVariant>): Variant {
    const price = this.amount(input.price);
    contract(!price.amount.startsWith("-"));
    return { id: input.id, name: safeText(input.name ?? ""),
      options: input.options.map((option) => ({ name: safeText(option.name, 150), value: safeText(option.value) })),
      price, available: input.available ?? null, requires_shipping: input.requiresShipping ?? null };
  }
  private quoteValue(input: unknown): Quote {
    const parsed = wireQuote.safeParse(input);
    contract(parsed.success);
    const quote = parsed.data;
    contract(Number.isFinite(Date.parse(quote.expiresAt)));
    const b = quote.amountBreakdown;
    return { id: quote.id, expires_at: quote.expiresAt,
      shipping_options: quote.shippingOptions.map((option) => ({ id: option.id, name: safeText(option.name), selected: option.selected, price: this.amount(option.price),
        details: (option.details ?? []).map((detail) => ({ key: safeText(detail.key), value: safeText(detail.value) })) })),
      breakdown: { items_subtotal: this.amount(b.itemsSubtotal), shipping: b.shipping ? this.amount(b.shipping) : null,
        tax: b.tax ? { amount: this.amount(b.tax.amount), included_in_prices: b.tax.includedInPrices ?? null } : null,
        discounts: b.discounts.map((item) => ({ name: safeText(item.name), amount: this.amount(item.amount) })),
        additional_charges: b.additionalCharges.map((item) => ({ name: safeText(item.name), amount: this.amount(item.amount) })), final_amount: this.amount(b.finalAmount) },
      raw_amounts: { items_subtotal: b.itemsSubtotal.amount.value, final_amount: b.finalAmount.amount.value,
        ...(b.shipping ? { shipping: b.shipping.amount.value } : {}), ...(b.tax ? { tax: b.tax.amount.amount.value } : {}),
        ...Object.fromEntries(b.discounts.map((item, i) => [`discount_${i}`, item.amount.amount.value])),
        ...Object.fromEntries(b.additionalCharges.map((item, i) => [`charge_${i}`, item.amount.amount.value])),
        ...Object.fromEntries(quote.shippingOptions.map((item, i) => [`shipping_option_${i}`, item.price.amount.value])) },
    };
  }
  private enrollmentValue(input: unknown): Enrollment {
    const parsed = wireEnrollment.safeParse(input);
    contract(parsed.success);
    const enrollment = parsed.data;
    return { id: enrollment.id, status: safeText(enrollment.status, 100), owner_reference: enrollment.owner.id,
      next_action: this.redirect(enrollment.nextAction),
      masked_label: enrollment.paymentMethod?.last4 ? `${safeText(enrollment.paymentMethod.network ?? "Card", 30)} ending ${enrollment.paymentMethod.last4}` : null };
  }
  private checkoutValue(input: unknown): Checkout {
    const parsed = wireCheckout.safeParse(input);
    contract(parsed.success);
    const checkout = parsed.data;
    return { id: checkout.id, status: safeText(checkout.status, 100), quote_id: checkout.quoteId ?? null,
      enrollment_id: checkout.enrollmentId ?? null, next_action: this.redirect(checkout.nextAction),
      final_amount: checkout.finalAmount ? this.amount(checkout.finalAmount) : null,
      order_reference: checkout.orderId ? safeText(checkout.orderId, 300) : null };
  }

  async search(input: SearchRequest): Promise<SearchResponse> {
    const unit = this.unit();
    const max = input.max_item_price === undefined ? undefined : unit === "major" ? input.max_item_price : new Decimal(input.max_item_price).times(new Decimal(10).pow(currencyDigits(input.currency))).toFixed(0);
    const result = await this.http("POST", "/agentic/products/search", JSON.stringify({
      query: input.query, context: { country: input.country, currency: input.currency },
      ...(input.merchant ? { merchantPreference: { mode: "ONLY", merchantName: input.merchant } } : {}),
      filters: { availability: "AVAILABLE_ONLY", ...(max !== undefined ? { price: { max } } : {}) },
      pagination: { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) },
    }));
    const parsed = z.object({
      products: z.array(z.object({ id: text, name: text, merchant: z.object({ name: text }), imageUrl: text.optional(),
        priceRange: z.object({ min: wireMoney, max: wireMoney }), available: z.boolean().optional(),
        previewVariant: z.object({ id: text, name: z.string().optional(), price: wireMoney, available: z.boolean().optional() }).optional() })).max(50),
      pagination: z.object({ nextCursor: z.string().max(8192).nullable() }), warnings: z.array(z.string()).max(50),
    }).safeParse(result);
    contract(parsed.success);
    return { products: parsed.data.products.map((product) => ({ id: product.id, name: safeText(product.name), merchant: safeText(product.merchant.name, 150),
      image_url: product.imageUrl ?? null, available: product.available ?? null,
      price_range: { min: this.amount(product.priceRange.min), max: this.amount(product.priceRange.max) },
      preview_variant: product.previewVariant ? { id: product.previewVariant.id, name: safeText(product.previewVariant.name ?? ""), price: this.amount(product.previewVariant.price),
        available: product.previewVariant.available ?? null, requires_shipping: null, options: [] } : null })),
      warnings: parsed.data.warnings.map((warning) => safeText(warning, 500)), next_cursor: parsed.data.pagination.nextCursor };
  }

  async details(id: string): Promise<Details> {
    const result = await this.http("POST", "/agentic/products/details", JSON.stringify({ productIds: [id] }));
    const parsed = z.object({ products: z.array(wireDetails).max(10), errors: z.array(z.object({ productId: text, code: text })).max(10) }).safeParse(result);
    contract(parsed.success);
    const product = parsed.data.products.find((item) => item.id === id);
    if (!product) throw new AppError("PRODUCT_UNAVAILABLE", "Reap could not resolve this product. Search again; no substitute was selected.");
    return { id: product.id, name: safeText(product.name), merchant: safeText(product.merchant.name, 150),
      options: product.options.map((group) => ({ name: safeText(group.name, 150), values: group.values.map((value) => ({ option_id: value.optionId, label: safeText(value.label), available: value.available ?? null })) })),
      default_variant: this.variantValue(product.defaultVariant) };
  }
  async variant(productId: string, optionIds: string[]): Promise<Variant> {
    const parsed = wireVariant.safeParse(await this.http("POST", "/agentic/products/variant", JSON.stringify({ productId, optionIds })));
    contract(parsed.success);
    return this.variantValue(parsed.data);
  }
  async enrollment(id: string): Promise<Enrollment> {
    const result = this.enrollmentValue(await this.http("GET", `/agentic/enrollments/${encodeURIComponent(id)}`, undefined, undefined, {}, true));
    contract(result.id === id);
    return result;
  }
  async quote(id: string): Promise<Quote> {
    const result = this.quoteValue(await this.http("GET", `/agentic/quotes/${encodeURIComponent(id)}`));
    contract(result.id === id);
    return result;
  }
  async checkout(id: string): Promise<Checkout> {
    const result = this.checkoutValue(await this.http("GET", `/agentic/checkouts/${encodeURIComponent(id)}`, undefined, undefined, {}, true));
    contract(result.id === id);
    return result;
  }

  private build(kind: ProviderRequest["kind"], path: string, body: unknown): ProviderRequest {
    return { kind, path, method: "POST", body: JSON.stringify(body), headers: { "Reap-Version": this.config.reap.version } };
  }
  enrollmentRequest(owner: string, email: string, callback: string): ProviderRequest {
    if (!this.config.hostedHosts.length) throw new AppError("REAP_FEATURE_NOT_ENABLED", "Configure Reap-confirmed hosted URL hosts before enrollment.");
    return this.build("enrollment", "/agentic/enrollments", { source: "EXTERNAL", owner: { type: "CLIENT_REFERENCE", id: owner, email }, presentation: { type: "REDIRECT", returnUrl: callback } });
  }
  quoteRequest(input: QuoteRequest): ProviderRequest {
    this.unit();
    const d = input.delivery;
    if (d) contract(d.first_name && d.last_name && d.phone && /^\+[1-9]\d{6,14}$/.test(d.phone), "Reap requires explicit first/last names and an international-format phone number. No address mapping was guessed.");
    return this.build("quote", "/agentic/quotes", { email: input.email, items: [{ variantId: input.variant_id, quantity: input.quantity }],
      ...(input.offer_code ? { offerCode: input.offer_code } : {}),
      ...(d ? { shippingAddress: { firstName: d.first_name, lastName: d.last_name, phone: d.phone, addressLine1: d.line1,
        ...(d.line2 ? { addressLine2: d.line2 } : {}), city: d.city, ...(d.region ? { region: d.region } : {}), postalCode: d.postal_code, country: d.country } } : {}) });
  }
  shippingRequest(id: string, optionId: string): ProviderRequest { return this.build("shipping", `/agentic/quotes/${encodeURIComponent(id)}/shipping-option`, { shippingOptionId: optionId }); }
  checkoutRequest(quoteId: string, enrollmentId: string, callback: string): ProviderRequest {
    this.checkoutGate();
    const request = this.build("checkout", "/agentic/checkouts", { quoteId, enrollmentId, presentation: { type: "REDIRECT", returnUrl: callback } });
    if (this.config.reap.simulate) request.headers["X-Simulate-Checkout"] = "COMPLETED";
    return request;
  }
  private checkoutGate(simulated = this.config.reap.simulate): void {
    const r = this.config.reap;
    if (!r.checkoutEnabled || r.moneyUnit === "unverified" || !r.returnUrlConfirmed || !this.config.hostedHosts.length || (!simulated && (!r.approvalConfirmed || !r.approvalVerificationRef))) {
      throw new AppError("REAP_FEATURE_NOT_ENABLED", "Checkout is disabled until this project's merchant, units, callback and per-purchase hosted approval are verified.");
    }
  }
  async execute(request: ProviderRequest, key: string): Promise<ProviderResult> {
    if (request.kind === "checkout") this.checkoutGate(request.headers["X-Simulate-Checkout"] === "COMPLETED");
    const allowed = new Set(["Reap-Version", "X-Simulate-Checkout"]);
    contract(Object.keys(request.headers).every((name) => allowed.has(name)));
    contract(!request.headers["X-Simulate-Checkout"] || (request.kind === "checkout" && request.headers["X-Simulate-Checkout"] === "COMPLETED"));
    const response = await this.http(request.method, request.path, request.body, key, request.headers);
    if (request.kind === "enrollment") return { kind: "enrollment", value: this.enrollmentValue(response) };
    if (request.kind === "checkout") return { kind: "checkout", value: this.checkoutValue(response) };
    return { kind: "quote", value: this.quoteValue(response) };
  }

  private async http(method: string, path: string, body?: string, key?: string, headers: Record<string, string> = {}, statusRead = false): Promise<unknown> {
    contract(path.startsWith("/agentic/") && !path.includes("?") && !path.includes("#"));
    const deadline = Date.now() + (statusRead ? this.config.statusTimeoutMs : this.config.upstreamTimeoutMs);
    let lastError: AppError = new AppError("UPSTREAM_UNAVAILABLE", "Reap is unavailable. Check the saved operation status before retrying.", true, null, Boolean(key));
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const response = await this.fetcher(new URL(path, this.config.reap.baseUrl), {
          method, redirect: "error", signal: AbortSignal.timeout(remaining),
          headers: { Authorization: `Bearer ${this.config.reap.apiKey}`, "Reap-Version": this.config.reap.version,
            "Content-Type": "application/json", ...headers, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body !== undefined ? { body } : {}),
        });
        const textBody = await this.readBody(response);
        let json: unknown;
        try { json = parse(textBody); } catch { throw new AppError("UPSTREAM_CONTRACT_ERROR", "Reap returned a non-JSON response. The operation outcome must be checked.", false, null, Boolean(key)); }
        if (response.ok) return json;
        lastError = this.providerError(response.status, json, Boolean(key));
        lastError.retryAfterMs = response.status === 429 ? retryDelay(response.headers.get("Retry-After")) : 250 * 2 ** attempt;
        if (!lastError.retryable || (key && response.status >= 500)) throw lastError;
      } catch (error) {
        if (error instanceof AppError) {
          lastError = error;
          if (!error.retryable || (key && error.uncertain && error.upstreamCode !== null)) throw error;
        } else lastError = new AppError("UPSTREAM_UNAVAILABLE", "Reap timed out or the connection failed. The original operation remains pending; do not create a replacement.", true, null, Boolean(key));
      }
      const wait = lastError.retryAfterMs + Math.floor(Math.random() * 100);
      if (Date.now() + wait >= deadline) break;
      await sleep(wait);
    }
    throw lastError;
  }

  private async readBody(response: Response): Promise<string> {
    contract(response.body && response.headers.get("content-type")?.toLowerCase().includes("json"), "Reap returned an unexpected response format.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) { await reader.cancel(); throw new AppError("UPSTREAM_CONTRACT_ERROR", "Reap's response exceeded the configured size limit.", false, null, true); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private providerError(status: number, payload: unknown, mutation: boolean): AppError {
    const parsed = z.object({ error: z.object({ code: z.string().regex(/^[A-Z0-9_]{1,100}$/), detail: z.unknown().optional() }) }).safeParse(payload);
    const code = parsed.success ? parsed.data.error.code : "UNRECOGNIZED_ERROR";
    const mapping: Record<string, [string, string]> = {
      AGENTIC_PAYMENTS_NOT_ENABLED: ["REAP_FEATURE_NOT_ENABLED", "Agentic Payments is not enabled for this Reap project. Ask Reap to enable the required sandbox features."],
      VARIANT_UNAVAILABLE: ["PRODUCT_UNAVAILABLE", "That variant is unavailable. Ask the user to choose another; never substitute automatically."],
      ENROLLMENT_NOT_ACTIVE: ["PAYMENT_METHOD_NOT_ACTIVE", "Recheck enrollment using connect_payment_method before requesting purchase."],
      QUOTE_EXPIRED: ["QUOTE_EXPIRED", "The quote expired. Prepare and review a new user-directed draft."],
      MERCHANT_NOT_RESOLVED: ["UNSUPPORTED_REGION_OR_MERCHANT", "Reap could not resolve the configured merchant. Confirm merchant coverage with Reap."],
      IDEMPOTENT_PARAMETER_MISMATCH: ["RECONCILIATION_REQUIRED", "The stored idempotency request conflicts with Reap's record. Do not use a new checkout key; investigate the original operation."],
    };
    if (code === "QUOTE_UNFULFILLABLE" && parsed.success) {
      const detail = z.object({ reason: z.string() }).safeParse(parsed.data.error.detail);
      const field = detail.success ? ({ INVALID_PHONE: "phone", STATE_OR_PROVINCE_REQUIRED: "region", ADDRESS_LINE_2_REQUIRED: "line2" } as Record<string, string>)[detail.data.reason] : undefined;
      if (field) {
        const failure = new AppError("NEEDS_INPUT", "Ask for the missing delivery field, then prepare a corrected draft with a new operation_key.", false, code);
        failure.data = { required_fields: [{ field: `shipping_address.${field}`, reason: "The merchant requires this field for the selected delivery address." }] };
        return failure;
      }
    }
    if (mapping[code]) return new AppError(mapping[code][0], mapping[code][1], false, code, code === "IDEMPOTENT_PARAMETER_MISMATCH");
    if (status === 429 || code === "IDEMPOTENCY_REQUEST_IN_PROGRESS") return new AppError(status === 429 ? "UPSTREAM_RATE_LIMITED" : "CHECKOUT_PENDING", "Reap asked this operation to wait. Keep the original request and idempotency key; recheck its status after the retry delay.", true, code, mutation);
    if (status >= 500) return new AppError("UPSTREAM_UNAVAILABLE", "Reap could not establish the operation outcome. Reconcile or replay only the original durable operation; never rotate checkout keys.", true, code, mutation);
    if (status === 401 || status === 403) return new AppError("REAP_AUTH_FAILED", "The server's Reap project credential or API access was rejected. Ask the operator to check the sandbox configuration.", false, code);
    return new AppError("UPSTREAM_REJECTED", "Reap rejected the request. Correct the selected product, offer or delivery information before a fresh preparation; do not blindly retry checkout.", false, code);
  }
}
