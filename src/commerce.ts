import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Config } from "./config.js";
import { Database } from "./db.js";
import { checkoutStates, terminalStates, type Actor, type Checkout, type Delivery, type Enrollment, type Identity, type Operation, type PaymentMethod, type PrivatePurchase, type Provider, type ProviderResult, type Purchase, type Quote, type Redirect, type Selection } from "./domain.js";
import { AppError, asAppError, contract, log } from "./errors.js";
import { equalMoney, money, withinBudget } from "./money.js";
import { Operations } from "./operations.js";
import { inputSchemas, outputSchemas, type CreateInput, type Envelope, type NeededField, type SearchInput, type ShippingInput, type ToolName } from "./schemas.js";
import { canonical, hash, opaqueToken, safeText, safeUrl } from "./security.js";

export const requiredScopes: Record<ToolName, string> = {
  connect_payment_method: "payment-methods:write", search_products: "commerce:read", prepare_purchase: "commerce:prepare",
  request_purchase: "commerce:checkout", get_purchase_status: "commerce:read",
};
const currentMethods = ["CREATING", "REQUIRES_ACTION", "ACTIVE", "UNKNOWN_RECONCILIATION_REQUIRED"];
const enrollmentStates = new Set(["REQUIRES_ACTION", "ACTIVE", "FAILED", "EXPIRED", "REVOKED"]);
interface CatalogItem { id: string; provider_product_id: string; country: string; currency: string; merchant_key: string; expires_at: Date }
interface Callback { user_id: string; resource_id: string; resource_kind: "payment-method" | "purchase"; expires_at: Date }

export class Commerce {
  readonly operations: Operations;

  constructor(readonly db: Database, readonly provider: Provider, readonly config: Config) {
    this.operations = new Operations(db, provider);
  }

  async call(name: ToolName, input: unknown, identity: Identity): Promise<Envelope> {
    let actor: Actor | null = null;
    try {
      if (!identity.scopes.includes(requiredScopes[name])) throw new AppError("FORBIDDEN", `This action requires the ${requiredScopes[name]} scope. Reconnect with the required permission.`);
      actor = await this.db.actor(identity);
      await this.db.rateLimit(actor.id);
      let result: Envelope;
      switch (name) {
        case "connect_payment_method": result = await this.connect(actor, inputSchemas.connect_payment_method.parse(input).payment_method_id); break;
        case "search_products": result = await this.search(actor, inputSchemas.search_products.parse(input)); break;
        case "prepare_purchase": {
          const parsed = inputSchemas.prepare_purchase.parse(input);
          result = parsed.action === "create" ? await this.prepare(actor, parsed) : await this.selectShipping(actor, parsed);
          break;
        }
        case "request_purchase": result = await this.request(actor, inputSchemas.request_purchase.parse(input)); break;
        case "get_purchase_status": result = await this.status(actor.id, inputSchemas.get_purchase_status.parse(input).purchase_id); break;
      }
      outputSchemas[name].parse(result);
      await this.db.audit(actor.id, name, result.status, randomUUID());
      return result;
    } catch (error) {
      const failure = error instanceof z.ZodError
        ? new AppError("INVALID_INPUT", `Check the documented fields: ${error.issues.map((issue) => issue.path.join(".") || "arguments").slice(0, 8).join(", ")}. Unknown properties are not accepted.`)
        : asAppError(error);
      log("tool_error", { code: failure.code, trace_id: failure.traceId, upstream_code: failure.upstreamCode });
      if (actor) {
        try { await this.db.audit(actor.id, name, failure.code, failure.traceId); }
        catch { log("audit_unavailable", { trace_id: failure.traceId }); }
      }
      if (failure.code === "NEEDS_INPUT" && failure.data) return this.ok("NEEDS_INPUT", failure.data, { type: "PROVIDE_INPUT", message: failure.message });
      const result: Envelope = {
        ok: false, mode: this.config.mode, simulated: this.config.mode === "mock", status: failure.code, data: failure.data,
        next_action: { type: failure.uncertain ? "RECONCILE" : "CORRECT_REQUEST", message: failure.message },
        error: { code: failure.code, message: failure.message.slice(0, 500), retryable: failure.retryable, trace_id: failure.traceId },
      };
      return result;
    }
  }

  private ok(status: string, data: Record<string, unknown>, next: Envelope["next_action"] = null, simulated = this.config.mode === "mock"): Envelope {
    return { ok: true, mode: this.config.mode, simulated, status, data, next_action: next };
  }
  private needs(fields: NeededField[]): Envelope {
    return this.ok("NEEDS_INPUT", { required_fields: fields }, { type: "PROVIDE_INPUT", message: "Ask the user for the listed choices or profile information. Do not guess." });
  }
  private region(country: string, currency: string): void {
    if (!this.config.countries.includes(country) || !this.config.currencies.includes(currency)) throw new AppError("UNSUPPORTED_REGION_OR_MERCHANT", `Supported countries: ${this.config.countries.join(", ")}; currencies: ${this.config.currencies.join(", ")}.`);
  }
  private merchant(name: string): string {
    if (this.config.allowAllMerchants) return safeText(name, 150);
    const found = Object.entries(this.config.merchants).find(([, configured]) => configured.toLowerCase() === name.toLowerCase());
    if (!found) throw new AppError("UNSUPPORTED_REGION_OR_MERCHANT", "This merchant is not in the server's verified merchant configuration.");
    return found[0];
  }

  private async callbackUrl(client: PoolClient, userId: string, resourceId: string, kind: Callback["resource_kind"]): Promise<string> {
    const reference = opaqueToken();
    await client.query("INSERT INTO callbacks (reference_hash,user_id,namespace,resource_kind,resource_id,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '24 hours')", [hash(reference), userId, this.config.namespace, kind, resourceId]);
    const url = new URL(`/callbacks/${kind}`, this.config.publicUrl);
    url.searchParams.set("ref", reference);
    return url.href;
  }

  private async connect(actor: Actor, methodId?: string): Promise<Envelope> {
    return this.db.locked(`enrollment:${actor.id}`, async (client) => {
      let method = methodId ? await this.db.payment(methodId, actor.id, client) :
        (await this.db.query<PaymentMethod>("SELECT * FROM payment_methods WHERE user_id=$1 AND namespace=$2 AND status=ANY($3::text[]) ORDER BY created_at DESC LIMIT 1", [actor.id, this.config.namespace, currentMethods], client))[0];
      if (!method) {
        if (!actor.email || !actor.emailVerified || !z.email().safeParse(actor.email).success) {
          return this.needs([{ field: "profile.email", reason: "Enrollment needs a verified email from your OAuth profile (or the configured local demo profile), not a model-supplied owner." }]);
        }
        const id = randomUUID();
        const operation = await this.db.transaction(async (tx) => {
          await tx.query("INSERT INTO payment_methods (id,user_id,namespace,status) VALUES ($1,$2,$3,'CREATING')", [id, actor.id, this.config.namespace]);
          const callback = await this.callbackUrl(tx, actor.id, id, "payment-method");
          return this.operations.create(tx, actor.id, id, id, this.provider.enrollmentRequest(actor.ownerReference, actor.email!, callback));
        }, client);
        await this.resume(operation);
        method = await this.db.payment(id, actor.id, client);
      } else {
        const [operation] = await this.db.query<Operation>("SELECT * FROM operations WHERE payment_method_id=$1 AND applied_at IS NULL ORDER BY created_at LIMIT 1", [method.id], client);
        if (operation) await this.resume(operation);
        method = await this.db.payment(method.id, actor.id, client);
      }
      if (method.enrollment_id) method = await this.refreshMethod(method);
      return this.methodResult(method);
    });
  }

  private methodResult(method: PaymentMethod): Envelope {
    const details = method.details_ciphertext ? this.db.box.open<Enrollment>(method.details_ciphertext, `payment:${method.id}`) : null;
    const redirect = method.status === "REQUIRES_ACTION" ? details?.next_action : null;
    const url = redirect ? safeUrl(redirect.url, this.config) : null;
    return this.ok(method.status, {
      payment_method_id: method.id, enrollment_status: method.status, setup_url: url,
      setup_expires_at: redirect?.expires_at ?? null, masked_label: details?.masked_label ?? null,
    }, method.status === "ACTIVE" ? null : {
      type: url ? "OPEN_SETUP" : currentMethods.includes(method.status) ? "RECHECK_ENROLLMENT" : "START_NEW_SETUP",
      message: url ? "Open the hosted setup page yourself, then call connect_payment_method again to verify enrollment." :
        currentMethods.includes(method.status) ? "Recheck this saved enrollment. A pending or unknown attempt must not be replaced." : "This enrollment is no longer usable. Call connect_payment_method without an ID to start a fresh setup.",
      ...(url ? { url } : {}),
    });
  }

  private async refreshMethod(method: PaymentMethod): Promise<PaymentMethod> {
    contract(method.enrollment_id);
    const enrollment = await this.provider.enrollment(method.enrollment_id);
    await this.saveEnrollment(method.id, method.user_id, enrollment, true);
    return this.db.payment(method.id, method.user_id);
  }

  private async saveEnrollment(id: string, userId: string, enrollment: Enrollment, verifiedRead: boolean, client?: PoolClient): Promise<void> {
    const [owner] = await this.db.query<{ owner_reference: string }>("SELECT owner_reference FROM users WHERE id=$1", [userId], client);
    contract(owner && enrollment.owner_reference === owner.owner_reference, "Reap returned an enrollment for an unexpected owner. No card can be used.");
    if (enrollment.next_action) safeUrl(enrollment.next_action.url, this.config);
    let state = enrollmentStates.has(enrollment.status) ? enrollment.status : "UNKNOWN_RECONCILIATION_REQUIRED";
    if (state === "ACTIVE" && !verifiedRead) state = "CREATING";
    await this.db.query("UPDATE payment_methods SET enrollment_id=$2,status=$3,details_ciphertext=$4,updated_at=now() WHERE id=$1 AND user_id=$5 AND namespace=$6", [id, enrollment.id, state, this.db.box.seal(enrollment, `payment:${id}`), userId, this.config.namespace], client);
  }

  private async search(actor: Actor, input: SearchInput): Promise<Envelope> {
    this.region(input.country, input.currency);
    const merchant = input.merchant_preference && (this.config.allowAllMerchants ? input.merchant_preference : this.config.merchants[input.merchant_preference]);
    if (input.merchant_preference && !merchant) throw new AppError("UNSUPPORTED_REGION_OR_MERCHANT", "Choose an approved configured merchant key.");
    if (input.max_item_price) this.inputMoney(input.max_item_price, input.currency);
    const { cursor, ...criteria } = input;
    const contextHash = hash(canonical(criteria));
    let providerCursor: string | undefined;
    if (cursor) {
      const [saved] = await this.db.query<{ context_hash: string; cursor_ciphertext: string; expires_at: Date }>("SELECT * FROM search_cursors WHERE id=$1 AND user_id=$2 AND namespace=$3", [cursor, actor.id, this.config.namespace]);
      if (!saved || saved.context_hash !== contextHash || saved.expires_at.getTime() <= Date.now()) throw new AppError("INVALID_CURSOR", "Start a new search; this cursor is expired or belongs to different search criteria.");
      providerCursor = this.db.box.open<string>(saved.cursor_ciphertext, `cursor:${cursor}`);
    }
    const found = await this.provider.search({ query: input.query, country: input.country, currency: input.currency, limit: input.limit,
      ...(input.max_item_price ? { max_item_price: input.max_item_price } : {}),
      ...(merchant ? { merchant } : {}),
      ...(providerCursor ? { cursor: providerCursor } : {}) });
    const warnings = found.warnings.map((value) => safeText(value, 500)).slice(0, 20);
    const products: Record<string, unknown>[] = [];
    for (const product of found.products.slice(0, input.limit)) {
      const merchantKey = this.config.allowAllMerchants ? this.merchant(product.merchant) : Object.entries(this.config.merchants).find(([, name]) => name.toLowerCase() === product.merchant.toLowerCase())?.[0];
      if (!merchantKey || (merchant && product.merchant.toLowerCase() !== merchant.toLowerCase())) {
        warnings.push("A result outside the configured merchant allowlist was omitted.");
        continue;
      }
      contract(product.price_range.min.currency === input.currency && product.price_range.max.currency === input.currency);
      if (input.max_item_price && !withinBudget(product.price_range.min, input.max_item_price, null)) continue;
      const [record] = await this.db.query<{ id: string }>("INSERT INTO catalog_items (id,user_id,namespace,provider_product_id,country,currency,merchant_key,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '24 hours') ON CONFLICT (user_id,namespace,provider_product_id,country,currency) DO UPDATE SET merchant_key=EXCLUDED.merchant_key,expires_at=EXCLUDED.expires_at RETURNING id", [randomUUID(), actor.id, this.config.namespace, product.id, input.country, input.currency, merchantKey]);
      contract(record);
      let imageUrl: string | null = null;
      if (product.image_url) {
        try { imageUrl = safeUrl(product.image_url, this.config, "catalog"); }
        catch { warnings.push("An image URL was omitted because its host is not allowlisted."); }
      }
      products.push({ product_id: record.id, name: safeText(product.name), merchant: { key: merchantKey, name: safeText(product.merchant, 150) },
        availability: product.available === null ? "UNKNOWN" : product.available ? "AVAILABLE" : "UNAVAILABLE",
        image_url: imageUrl, price_range: product.price_range,
        preview_variant: product.preview_variant ? { name: safeText(product.preview_variant.name), price: product.preview_variant.price, available: product.preview_variant.available } : null });
    }
    let nextCursor: string | null = null;
    if (found.next_cursor) {
      nextCursor = randomUUID();
      await this.db.query("INSERT INTO search_cursors (id,user_id,namespace,context_hash,cursor_ciphertext,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '30 minutes')", [nextCursor, actor.id, this.config.namespace, contextHash, this.db.box.seal(found.next_cursor, `cursor:${nextCursor}`)]);
    }
    warnings.push("Search prices are indicative and exclude final shipping, tax and other quote adjustments.");
    return this.ok("READY", { products, warnings, next_cursor: nextCursor, pricing: "INDICATIVE" }, products.length ? null : { type: "REFINE_SEARCH", message: "No supported products matched. Refine the query or choose another approved merchant." });
  }

  private inputMoney(value: string, currency: string): void {
    try { money(value, currency); }
    catch { throw new AppError("INVALID_INPUT", "Use a non-negative decimal amount with the currency's supported precision."); }
  }

  private async prepare(actor: Actor, input: CreateInput): Promise<Envelope> {
    return this.db.locked(`prepare:${actor.id}:${input.operation_key}`, async (client) => {
      const inputHash = hash(canonical({ ...input, ...(input.option_ids ? { option_ids: [...input.option_ids].sort() } : {}) }));
      const [existing] = await this.db.query<Purchase>("SELECT * FROM purchases WHERE user_id=$1 AND namespace=$2 AND operation_key=$3", [actor.id, this.config.namespace, input.operation_key], client);
      if (existing) {
        if (existing.input_hash !== inputHash) throw new AppError("IDEMPOTENCY_CONFLICT", "This preparation key already belongs to different terms. Recheck that draft, or use a new key for a genuinely new preparation.");
        return this.db.locked(`purchase:${existing.id}`, async () => {
          await this.resumePending(existing.id);
          return this.purchaseResult(await this.db.purchase(existing.id, actor.id));
        });
      }
      this.region(input.country, input.currency);
      if (input.max_total) this.inputMoney(input.max_total, input.currency);
      const [catalogItem] = await this.db.query<CatalogItem>("SELECT * FROM catalog_items WHERE id=$1 AND user_id=$2 AND namespace=$3", [input.product_id, actor.id, this.config.namespace], client);
      if (!catalogItem || catalogItem.expires_at.getTime() <= Date.now()) throw new AppError("PRODUCT_UNAVAILABLE", "Search again and select a current product returned for your account.");
      if (catalogItem.country !== input.country || catalogItem.currency !== input.currency) throw new AppError("INVALID_INPUT", "Search again in the intended country and currency before preparing this product.");
      const details = await this.provider.details(catalogItem.provider_product_id);
      contract(details.id === catalogItem.provider_product_id);
      const merchantKey = this.merchant(details.merchant);
      contract(merchantKey === catalogItem.merchant_key, "The product's merchant changed. Search again before preparing it.");
      const selected = input.option_ids ?? [];
      if (new Set(selected).size !== selected.length) throw new AppError("INVALID_INPUT", "Each product option may be selected only once.");
      const allOptions = details.options.flatMap((group) => group.values);
      if (selected.some((option) => !allOptions.some((value) => value.option_id === option))) throw new AppError("INVALID_INPUT", "Select option IDs returned for this exact product.");
      const missing: NeededField[] = [];
      for (const group of details.options) {
        const chosen = group.values.filter((value) => selected.includes(value.option_id));
        if (chosen.length === 0) missing.push({ field: "option_ids", reason: `Choose ${safeText(group.name, 150)}.`, choices: group.values.map((value) => ({ id: value.option_id, label: safeText(value.label), available: value.available })) });
        if (chosen.length > 1) throw new AppError("INVALID_INPUT", "Choose exactly one value from each product option group.");
        if (chosen[0]?.available === false) throw new AppError("PRODUCT_UNAVAILABLE", "That option is unavailable. Choose another option explicitly.");
      }
      if (missing.length) return this.needs(missing);
      const variant = details.options.length ? await this.provider.variant(details.id, selected) : details.default_variant;
      if (variant.available !== true) throw new AppError("PRODUCT_UNAVAILABLE", "Variant availability could not be confirmed. Choose another product; no substitution was made.");
      contract(variant.price.currency === input.currency);
      const email = input.contact_email ?? (actor.emailVerified ? actor.email : null);
      if (!email) missing.push({ field: "contact_email", reason: "Provide an order contact email, or use a verified profile email." });
      const requiresShipping = variant.requires_shipping !== false;
      const delivery = input.shipping_address;
      if (requiresShipping) {
        const required = ["recipient_name", "line1", "city", "postal_code", "country", ...(this.config.mode === "sandbox" ? ["first_name", "last_name", "phone"] : [])] as const;
        for (const field of required) {
          if (!delivery?.[field as keyof typeof delivery]) missing.push({ field: `shipping_address.${field}`, reason: "The selected merchant requires this delivery field. Ask the user; do not infer names or an address." });
        }
        if (delivery?.phone && this.config.mode === "sandbox" && !/^\+[1-9]\d{6,14}$/.test(delivery.phone)) missing.push({ field: "shipping_address.phone", reason: "Use an international-format phone number beginning with + and country code." });
      }
      if (delivery?.country && delivery.country !== input.country) throw new AppError("UNSUPPORTED_REGION_OR_MERCHANT", "Shipping country must match the prepared purchase country.");
      if (missing.length) return this.needs(missing);
      const id = randomUUID();
      const selection: Selection = {
        product_id: input.product_id, provider_product_id: details.id, name: safeText(details.name), merchant_key: merchantKey, merchant_name: safeText(details.merchant, 150),
        variant_id: variant.id, variant_name: safeText(variant.name), options: variant.options.map((option) => ({ name: safeText(option.name, 150), value: safeText(option.value) })),
        option_ids: selected, quantity: input.quantity, country: input.country, currency: input.currency, requires_shipping: requiresShipping,
        delivery_summary: delivery?.country ? { country: delivery.country, postal_prefix: `${delivery.postal_code?.slice(0, 2) ?? ""}***` } : null,
      };
      const privateData: PrivatePurchase = { email: email!, delivery: requiresShipping ? delivery as Delivery : null, offer_code: input.offer_code ?? null };
      const operation = await this.db.transaction(async (tx) => {
        await tx.query("INSERT INTO purchases (id,user_id,namespace,operation_key,input_hash,selection,private_ciphertext,state,budget,simulated,pii_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'PREPARING',$8,$9,now()+($10*interval '1 hour'))", [id, actor.id, this.config.namespace, input.operation_key, inputHash, JSON.stringify(selection), this.db.box.seal(privateData, `purchase:${id}`), input.max_total ?? null, this.config.mode === "mock" || this.config.reap.simulate, this.config.piiRetentionHours]);
        return this.operations.create(tx, actor.id, id, id, this.provider.quoteRequest({ variant_id: variant.id, quantity: input.quantity, email: privateData.email, delivery: privateData.delivery, offer_code: privateData.offer_code, currency: input.currency }));
      }, client);
      return this.db.locked(`purchase:${id}`, async () => {
        await this.resume(operation);
        return this.purchaseResult(await this.db.purchase(id, actor.id));
      });
    });
  }

  private async selectShipping(actor: Actor, input: ShippingInput): Promise<Envelope> {
    await this.db.purchase(input.purchase_id, actor.id);
    return this.db.locked(`purchase:${input.purchase_id}`, async (client) => {
      const purchase = await this.db.purchase(input.purchase_id, actor.id, client);
      const [checkout] = await this.db.query("SELECT id FROM operations WHERE purchase_id=$1 AND kind='checkout'", [purchase.id], client);
      if (checkout) throw this.withPurchase("CHECKOUT_PENDING", "Checkout has already started. Shipping can no longer be modified on this draft.", purchase);
      const [retry] = await this.db.query<Operation>("SELECT * FROM operations WHERE purchase_id=$1 AND kind='shipping' AND logical_key=$2", [purchase.id, `${purchase.id}:${input.expected_revision}`], client);
      if (retry) {
        const request = retry.request_ciphertext ? this.db.box.open<{ body: string }>(retry.request_ciphertext, `operation:${retry.id}:request`) : null;
        if (!request || (JSON.parse(request.body) as { shippingOptionId: string }).shippingOptionId !== input.shipping_option_id) throw this.withPurchase("REVISION_MISMATCH", "That revision already selected a different shipping option. Review the latest quote.", purchase);
        await this.resume(retry);
        return this.purchaseResult(await this.db.purchase(purchase.id, actor.id));
      }
      this.ready(purchase, input.expected_revision);
      if (!purchase.quote?.shipping_options.some((option) => option.id === input.shipping_option_id)) throw new AppError("INVALID_INPUT", "Select one of the quoted shipping options.");
      const operation = await this.db.transaction(async (tx) => {
        const changed = await tx.query("UPDATE purchases SET state='UPDATING_QUOTE',updated_at=now() WHERE id=$1 AND revision=$2 AND state='READY' RETURNING id", [purchase.id, input.expected_revision]);
        if (!changed.rowCount) throw new AppError("REVISION_MISMATCH", "The purchase changed. Review its latest revision.");
        return this.operations.create(tx, actor.id, purchase.id, `${purchase.id}:${input.expected_revision}`, this.provider.shippingRequest(purchase.quote!.id, input.shipping_option_id));
      }, client);
      await this.resume(operation);
      return this.purchaseResult(await this.db.purchase(purchase.id, actor.id));
    });
  }

  private ready(purchase: Purchase, revision: number): void {
    if (purchase.revision !== revision) throw this.withPurchase("REVISION_MISMATCH", "Review the latest quote and use its exact revision. No checkout was created.", purchase);
    if (purchase.state !== "READY" || !purchase.quote) throw this.withPurchase("CHECKOUT_PENDING", "This draft is not ready for a new checkout. Read its status; terminal attempts require a fresh preparation.", purchase);
    if (Date.parse(purchase.quote.expires_at) <= Date.now()) throw this.withPurchase("QUOTE_EXPIRED", "The quote expired. Prepare a new draft and review the new terms.", purchase);
    if (!purchase.private_ciphertext || purchase.pii_expires_at.getTime() <= Date.now()) throw this.withPurchase("QUOTE_EXPIRED", "Delivery data has expired under the retention policy. Prepare a new draft.", purchase);
  }

  assertSandboxCheckout(): void {
    if (this.config.mode === "mock") return;
    const reap = this.config.reap;
    if (!reap.checkoutEnabled || reap.moneyUnit === "unverified" || !reap.returnUrlConfirmed || !this.config.hostedHosts.length ||
      (!reap.simulate && (!reap.approvalConfirmed || !reap.approvalVerificationRef))) {
      throw new AppError("REAP_FEATURE_NOT_ENABLED", "Sandbox checkout is disabled until monetary units, callback behavior, hosted hosts and per-purchase approval are verified for this project. Explicit sandbox simulation is configured separately by the operator.");
    }
  }

  private async request(actor: Actor, input: z.infer<typeof inputSchemas.request_purchase>): Promise<Envelope> {
    await this.db.purchase(input.purchase_id, actor.id);
    await this.db.payment(input.payment_method_id, actor.id);
    return this.db.locked(`purchase:${input.purchase_id}`, async (client) => {
      let purchase = await this.db.purchase(input.purchase_id, actor.id, client);
      const [existing] = await this.db.query<Operation>("SELECT * FROM operations WHERE purchase_id=$1 AND kind='checkout'", [purchase.id], client);
      if (existing) {
        if (!existing.applied_at) await this.resume(existing);
        return this.purchaseResult(await this.db.purchase(purchase.id, actor.id));
      }
      this.ready(purchase, input.expected_revision);
      this.assertSandboxCheckout();
      if (await this.db.checkoutBlocked()) throw this.withPurchase("RECONCILIATION_REQUIRED", "Checkout writes are disabled after a provider approval anomaly. Ask the operator to investigate.", purchase);
      this.region(purchase.selection.country, purchase.selection.currency);
      this.merchant(purchase.selection.merchant_name);
      const method = await this.refreshMethod(await this.db.payment(input.payment_method_id, actor.id));
      if (method.status !== "ACTIVE" || !method.enrollment_id) throw this.withPurchase("PAYMENT_METHOD_NOT_ACTIVE", "Use connect_payment_method to complete or recheck enrollment before checkout.", purchase);
      const refreshed = await this.provider.quote(purchase.quote!.id);
      contract(refreshed.id === purchase.quote!.id);
      this.validateQuote(refreshed);
      if (Date.parse(refreshed.expires_at) <= Date.now()) throw this.withPurchase("QUOTE_EXPIRED", "The refreshed quote expired. Prepare a new draft.", purchase);
      const material = (quote: Quote) => canonical({ breakdown: quote.breakdown, shipping: quote.shipping_options.filter((option) => option.selected) });
      if (material(refreshed) !== material(purchase.quote!)) {
        await this.db.transaction(async (tx) => {
          const updated = await tx.query("UPDATE purchases SET quote=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$3 AND state='READY' RETURNING id", [purchase.id, JSON.stringify(refreshed), input.expected_revision]);
          if (!updated.rowCount) throw new AppError("REVISION_MISMATCH", "The purchase changed. Review its latest revision.");
          await this.db.audit(actor.id, "request_purchase", "REVIEW_REQUIRED", randomUUID(), purchase.id,
            { previous_revision: purchase.revision, revision: purchase.revision + 1, previous_amount: purchase.quote!.breakdown.final_amount.amount, amount: refreshed.breakdown.final_amount.amount, currency: refreshed.breakdown.final_amount.currency }, tx);
        }, client);
        purchase = await this.db.purchase(purchase.id, actor.id);
        return this.purchaseResult(purchase, "REVIEW_REQUIRED", "The quote changed. Show the revised terms to the user before requesting checkout again.");
      }
      purchase.quote = refreshed;
      if (refreshed.breakdown.final_amount.currency !== purchase.selection.currency) throw this.withPurchase("REVIEW_REQUIRED", "The quote currency changed. Prepare a new draft in the intended currency; the previous budget cannot authorize currency conversion.", purchase);
      if (purchase.selection.requires_shipping && refreshed.shipping_options.length && refreshed.shipping_options.filter((option) => option.selected).length !== 1) {
        return this.purchaseResult(purchase, "NEEDS_INPUT", "Ask the user to select a shipping option with prepare_purchase before checkout.");
      }
      const cap = this.config.caps[refreshed.breakdown.final_amount.currency];
      if (!cap || !withinBudget(refreshed.breakdown.final_amount, cap, purchase.budget)) throw this.withPurchase("BUDGET_EXCEEDED", "The authoritative quote exceeds the user budget or server cap. Prepare a revised selection; no checkout was created.", purchase);
      const operation = await this.db.transaction(async (tx) => {
        const changed = await tx.query("UPDATE purchases SET state='CREATING_CHECKOUT',payment_method_id=$2,quote=$3,updated_at=now() WHERE id=$1 AND revision=$4 AND state='READY' RETURNING id", [purchase.id, method.id, JSON.stringify(refreshed), input.expected_revision]);
        if (!changed.rowCount) throw new AppError("REVISION_MISMATCH", "The purchase changed. Review the latest revision.");
        const callback = await this.callbackUrl(tx, actor.id, purchase.id, "purchase");
        return this.operations.create(tx, actor.id, purchase.id, purchase.id, this.provider.checkoutRequest(refreshed.id, method.enrollment_id!, callback));
      }, client);
      await this.resume(operation);
      return this.purchaseResult(await this.db.purchase(purchase.id, actor.id));
    });
  }

  private validateQuote(quote: Quote): void {
    contract(Number.isFinite(Date.parse(quote.expires_at)));
    const total = quote.breakdown.final_amount;
    contract(!total.amount.startsWith("-"));
    const amounts = [quote.breakdown.items_subtotal, quote.breakdown.shipping, quote.breakdown.tax?.amount,
      ...quote.breakdown.discounts.map((entry) => entry.amount), ...quote.breakdown.additional_charges.map((entry) => entry.amount), ...quote.shipping_options.map((entry) => entry.price)];
    contract(amounts.every((amount) => !amount || amount.currency === total.currency));
    contract(quote.shipping_options.filter((option) => option.selected).length <= 1);
  }

  private async resumePending(purchaseId: string): Promise<void> {
    const operations = await this.db.query<Operation>("SELECT * FROM operations WHERE purchase_id=$1 AND applied_at IS NULL ORDER BY created_at", [purchaseId]);
    for (const operation of operations) await this.resume(operation);
  }

  private async resume(operation: Operation): Promise<void> {
    try {
      if (operation.kind === "checkout" && operation.status !== "SUCCEEDED") this.assertSandboxCheckout();
      const result = await this.operations.run(operation);
      await this.apply(operation, result);
    } catch (error) {
      const failure = asAppError(error);
      const [saved] = await this.db.query<Operation>("SELECT * FROM operations WHERE id=$1", [operation.id]);
      const state = saved?.status === "FAILED" ? "FAILED" : "UNKNOWN_RECONCILIATION_REQUIRED";
      if (operation.purchase_id) {
        await this.db.query("UPDATE purchases SET state=$2,reconciliation_required=$3,updated_at=now() WHERE id=$1", [operation.purchase_id, state, state !== "FAILED"]);
        if (!failure.data) failure.data = this.purchaseView(await this.db.purchase(operation.purchase_id, operation.user_id));
      } else if (operation.payment_method_id) {
        await this.db.query("UPDATE payment_methods SET status=$2,updated_at=now() WHERE id=$1", [operation.payment_method_id, state]);
      }
      if (saved?.status === "FAILED") await this.db.query("UPDATE operations SET applied_at=now() WHERE id=$1", [operation.id]);
      if (operation.kind === "checkout" && failure.code === "UPSTREAM_CONTRACT_ERROR") await this.db.blockCheckout("CHECKOUT_CONTRACT_ANOMALY");
      throw failure;
    }
  }

  private async apply(operation: Operation, result: ProviderResult): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [saved] = await this.db.query<Operation>("SELECT * FROM operations WHERE id=$1 FOR UPDATE", [operation.id], tx);
      contract(saved);
      if (saved.applied_at) return;
      if (result.kind === "enrollment") {
        contract(operation.payment_method_id);
        await this.saveEnrollment(operation.payment_method_id, operation.user_id, result.value, false, tx);
      } else {
        contract(operation.purchase_id);
        const purchase = await this.db.purchase(operation.purchase_id, operation.user_id, tx);
        if (result.kind === "quote") {
          this.validateQuote(result.value);
          contract(result.value.breakdown.final_amount.currency === purchase.selection.currency);
          await tx.query("UPDATE purchases SET quote=$2,revision=revision+1,state=$3,reconciliation_required=false,updated_at=now() WHERE id=$1", [purchase.id, JSON.stringify(result.value), Date.parse(result.value.expires_at) > Date.now() ? "READY" : "EXPIRED"]);
        } else {
          await this.persistCheckout(purchase, result.value, true, tx);
        }
      }
      await tx.query("UPDATE operations SET applied_at=now() WHERE id=$1", [operation.id]);
    });
  }

  private async persistCheckout(purchase: Purchase, checkout: Checkout, initial: boolean, client?: PoolClient): Promise<void> {
    contract(!purchase.checkout_id || purchase.checkout_id === checkout.id);
    contract(!checkout.quote_id || checkout.quote_id === purchase.quote?.id);
    if (purchase.payment_method_id && checkout.enrollment_id) {
      const method = await this.db.payment(purchase.payment_method_id, purchase.user_id, client);
      contract(method.enrollment_id === checkout.enrollment_id);
    }
    if (checkout.next_action) safeUrl(checkout.next_action.url, this.config);
    let state = checkoutStates.has(checkout.status) ? checkout.status : "UNKNOWN_RECONCILIATION_REQUIRED";
    let reconciliation = state === "UNKNOWN_RECONCILIATION_REQUIRED";
    if (initial && !purchase.simulated && ["PROCESSING", "COMPLETED"].includes(checkout.status)) {
      await this.db.blockCheckout("APPROVAL_BYPASSED");
      reconciliation = true;
    }
    if (checkout.status === "REQUIRES_ACTION" && !checkout.next_action) { state = "UNKNOWN_RECONCILIATION_REQUIRED"; reconciliation = true; }
    if (checkout.status === "COMPLETED" && (!checkout.order_reference || !checkout.final_amount)) reconciliation = true;
    if (checkout.final_amount && purchase.quote && !equalMoney(checkout.final_amount, purchase.quote.breakdown.final_amount)) {
      reconciliation = true;
      await this.db.blockCheckout("CHARGED_AMOUNT_MISMATCH");
    }
    const regressed = terminalStates.has(purchase.state) && purchase.state !== checkout.status;
    if (regressed) { state = "UNKNOWN_RECONCILIATION_REQUIRED"; reconciliation = true; }
    const { next_action, ...publicCheckout } = checkout;
    await this.db.query("UPDATE purchases SET checkout_id=$2,provider_status=$3,state=$4,checkout_data=$5,link_ciphertext=$6,reconciliation_required=$7,last_checked_at=now(),updated_at=now() WHERE id=$1", [purchase.id, checkout.id, checkout.status, state,
      JSON.stringify(regressed ? purchase.checkout_data : publicCheckout), next_action ? this.db.box.seal(next_action, `purchase-link:${purchase.id}`) : null, reconciliation], client);
  }

  async status(userId: string, purchaseId: string): Promise<Envelope> {
    await this.db.purchase(purchaseId, userId);
    return this.db.locked(`purchase:${purchaseId}`, async () => {
      let purchase = await this.db.purchase(purchaseId, userId);
      if (purchase.checkout_id) {
        try {
          const checkout = await this.provider.checkout(purchase.checkout_id);
          await this.persistCheckout(purchase, checkout, false);
        } catch (error) {
          const failure = asAppError(error);
          failure.data = this.purchaseView(purchase);
          throw failure;
        }
      } else if (purchase.state === "READY" && purchase.quote && Date.parse(purchase.quote.expires_at) <= Date.now()) {
        await this.db.query("UPDATE purchases SET state='EXPIRED',updated_at=now() WHERE id=$1", [purchaseId]);
      }
      purchase = await this.db.purchase(purchaseId, userId);
      return this.purchaseResult(purchase);
    });
  }

  private purchaseView(purchase: Purchase): Record<string, unknown> {
    const quote = purchase.quote;
    const cap = quote ? this.config.caps[quote.breakdown.final_amount.currency] : undefined;
    const redirect = purchase.link_ciphertext ? this.db.box.open<Redirect>(purchase.link_ciphertext, `purchase-link:${purchase.id}`) : null;
    const actionable = purchase.state === "REQUIRES_ACTION" && redirect && (!redirect.expires_at || Date.parse(redirect.expires_at) > Date.now());
    const selection = purchase.selection;
    const warnings = purchase.simulated ? [this.config.mode === "mock" ? "Mock result: no real payment or merchant fulfillment." : "Sandbox checkout simulation: merchant fulfillment was simulated."] : [];
    if (purchase.reconciliation_required) warnings.push("The provider outcome needs reconciliation. Do not submit a replacement checkout.");
    if (quote?.breakdown.shipping === null) warnings.push("Shipping amount is unknown, not zero.");
    if (quote?.breakdown.tax === null) warnings.push("Tax amount is unknown, not zero.");
    if (purchase.provider_status === "COMPLETED" && !purchase.checkout_data?.order_reference) warnings.push("The provider reports completion but has not supplied a merchant order reference.");
    if (purchase.provider_status === "COMPLETED" && !purchase.checkout_data?.final_amount) warnings.push("The actual charged amount has not been supplied by the provider.");
    return {
      purchase_id: purchase.id, revision: purchase.revision, state: purchase.state, provider_status: purchase.provider_status,
      product: { product_id: selection.product_id, name: selection.name, merchant: { key: selection.merchant_key, name: selection.merchant_name }, variant_name: selection.variant_name, selected_options: selection.options },
      quantity: selection.quantity, country: selection.country, currency: selection.currency, delivery_summary: selection.delivery_summary,
      quote: quote ? { expires_at: quote.expires_at, shipping_options: quote.shipping_options, breakdown: quote.breakdown } : null,
      budget: { max_total: purchase.budget ? money(purchase.budget, selection.currency) : null,
        server_cap: cap && quote ? money(cap, quote.breakdown.final_amount.currency) : null,
        within_budget: quote ? Boolean(cap && quote.breakdown.final_amount.currency === selection.currency && withinBudget(quote.breakdown.final_amount, cap, purchase.budget)) : null },
      approval_url: actionable ? safeUrl(redirect.url, this.config) : null, approval_expires_at: actionable ? redirect.expires_at : null,
      charged_amount: purchase.checkout_data?.final_amount ?? null, order_reference: purchase.checkout_data?.order_reference ?? null,
      last_checked_at: purchase.last_checked_at?.toISOString() ?? null, reconciliation_required: purchase.reconciliation_required, warnings,
    };
  }

  private purchaseResult(purchase: Purchase, override?: string, message?: string): Envelope {
    const data = this.purchaseView(purchase);
    let next: Envelope["next_action"] = null;
    if (purchase.reconciliation_required) next = { type: "RECONCILE", message: "Keep this purchase ID and reconcile the existing outcome. Never create a replacement to test whether the original succeeded." };
    else if (purchase.state === "READY") next = { type: "REVIEW_QUOTE", message: "Show the complete quote, selected product, shipping, currency and expiry. Only request this exact revision after the user chooses to proceed." };
    else if (purchase.state === "REQUIRES_ACTION" && typeof data.approval_url === "string") next = { type: "OPEN_APPROVAL", message: "The user must approve on the hosted page. A conversational response or callback is not payment authorization.", url: data.approval_url };
    else if (["PROCESSING", "PREPARING", "UPDATING_QUOTE", "CREATING_CHECKOUT"].includes(purchase.state)) next = { type: "CHECK_STATUS", message: "The existing operation is pending. Check this purchase again shortly; do not create another checkout.", retry_after_seconds: 5 };
    else if (["FAILED", "EXPIRED"].includes(purchase.state)) next = { type: "NEW_PREPARATION", message: "This attempt cannot be retried as a new checkout. A new user-directed purchase needs a fresh preparation and review." };
    if (message) next = { type: override === "NEEDS_INPUT" ? "SELECT_SHIPPING" : "REVIEW_QUOTE", message };
    return this.ok(override ?? purchase.state, data, next, purchase.simulated);
  }

  private withPurchase(code: string, message: string, purchase: Purchase): AppError {
    const error = new AppError(code, message);
    error.data = this.purchaseView(purchase);
    return error;
  }

  async verifyCallback(reference: string, kind: Callback["resource_kind"], identity?: Identity): Promise<Callback> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(reference)) throw new AppError("FORBIDDEN", "The callback reference is invalid or expired.");
    const [callback] = await this.db.query<Callback>("SELECT * FROM callbacks WHERE reference_hash=$1 AND namespace=$2 AND resource_kind=$3", [hash(reference), this.config.namespace, kind]);
    if (!callback || callback.expires_at.getTime() <= Date.now()) throw new AppError("FORBIDDEN", "The callback reference is invalid or expired.");
    if (identity && (await this.db.actor(identity)).id !== callback.user_id) throw new AppError("FORBIDDEN", "This callback belongs to another authenticated user.");
    return callback;
  }

  async callback(reference: string, kind: Callback["resource_kind"], identity?: Identity): Promise<Envelope> {
    const callback = await this.verifyCallback(reference, kind, identity);
    if (kind === "purchase") return this.status(callback.user_id, callback.resource_id);
    return this.db.locked(`enrollment:${callback.user_id}`, async () => {
      let method = await this.db.payment(callback.resource_id, callback.user_id);
      if (method.enrollment_id) method = await this.refreshMethod(method);
      return this.methodResult(method);
    });
  }

  async recover(): Promise<number> {
    const operations = await this.db.query<Operation>("SELECT * FROM operations WHERE namespace=$1 AND applied_at IS NULL AND next_attempt_at<=now() ORDER BY created_at LIMIT 5", [this.config.namespace]);
    let recovered = 0;
    for (const operation of operations) {
      const key = operation.purchase_id ? `purchase:${operation.purchase_id}` : `enrollment:${operation.user_id}`;
      try {
        await this.db.locked(key, () => this.resume(operation));
        recovered += 1;
      } catch (error) {
        const failure = asAppError(error);
        if (failure.code !== "OPERATION_PENDING") log("recovery_pending", { code: failure.code, trace_id: failure.traceId });
      }
    }
    return recovered;
  }
}
