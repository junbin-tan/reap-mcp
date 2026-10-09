import type { Money } from "./money.js";

export interface Identity {
  issuer: string;
  subject: string;
  scopes: readonly string[];
  email: string | null;
  emailVerified: boolean;
}

export interface Actor extends Identity { id: string; ownerReference: string }
export interface Redirect { url: string; expires_at: string | null }
export interface Enrollment { id: string; status: string; owner_reference: string; next_action: Redirect | null; masked_label: string | null }
export interface Variant {
  id: string;
  name: string;
  options: { name: string; value: string }[];
  price: Money;
  available: boolean | null;
  requires_shipping: boolean | null;
}
export interface Product {
  id: string;
  name: string;
  merchant: string;
  available: boolean | null;
  image_url: string | null;
  price_range: { min: Money; max: Money };
  preview_variant: Variant | null;
}
export interface Details {
  id: string;
  name: string;
  merchant: string;
  options: { name: string; values: { option_id: string; label: string; available: boolean | null }[] }[];
  default_variant: Variant;
}
export interface SearchRequest {
  query: string;
  country: string;
  currency: string;
  max_item_price?: string;
  merchant?: string;
  limit: number;
  cursor?: string;
}
export interface SearchResponse { products: Product[]; warnings: string[]; next_cursor: string | null }
export interface ShippingOption { id: string; name: string; selected: boolean; price: Money; details: { key: string; value: string }[] }
export interface Breakdown {
  items_subtotal: Money;
  shipping: Money | null;
  tax: { amount: Money; included_in_prices: boolean | null } | null;
  discounts: { name: string; amount: Money }[];
  additional_charges: { name: string; amount: Money }[];
  final_amount: Money;
}
export interface Quote { id: string; expires_at: string; shipping_options: ShippingOption[]; breakdown: Breakdown; raw_amounts: Record<string, string> }
export interface Checkout {
  id: string;
  status: string;
  quote_id: string | null;
  enrollment_id: string | null;
  next_action: Redirect | null;
  final_amount: Money | null;
  order_reference: string | null;
}
export interface Delivery {
  recipient_name: string;
  first_name?: string;
  last_name?: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postal_code: string;
  country: string;
  phone?: string;
}
export interface QuoteRequest { variant_id: string; quantity: number; email: string; delivery: Delivery | null; offer_code: string | null; currency: string }
export interface ProviderRequest {
  kind: "enrollment" | "quote" | "shipping" | "checkout";
  method: "POST";
  path: string;
  body: string;
  headers: Record<string, string>;
}
export type ProviderResult = { kind: "enrollment"; value: Enrollment } | { kind: "quote"; value: Quote } | { kind: "checkout"; value: Checkout };
export interface Provider {
  search(input: SearchRequest): Promise<SearchResponse>;
  details(id: string): Promise<Details>;
  variant(productId: string, optionIds: string[]): Promise<Variant>;
  enrollment(id: string): Promise<Enrollment>;
  quote(id: string): Promise<Quote>;
  checkout(id: string): Promise<Checkout>;
  enrollmentRequest(owner: string, email: string, callback: string): ProviderRequest;
  quoteRequest(input: QuoteRequest): ProviderRequest;
  shippingRequest(quoteId: string, optionId: string): ProviderRequest;
  checkoutRequest(quoteId: string, enrollmentId: string, callback: string): ProviderRequest;
  execute(request: ProviderRequest, idempotencyKey: string): Promise<ProviderResult>;
}

export const purchaseStates = ["PREPARING", "READY", "UPDATING_QUOTE", "CREATING_CHECKOUT", "REQUIRES_ACTION", "PROCESSING", "COMPLETED", "FAILED", "EXPIRED", "UNKNOWN_RECONCILIATION_REQUIRED"] as const;
export type PurchaseState = typeof purchaseStates[number];
export const checkoutStates = new Set(["REQUIRES_ACTION", "PROCESSING", "COMPLETED", "FAILED", "EXPIRED"]);
export const terminalStates = new Set(["COMPLETED", "FAILED", "EXPIRED"]);
export interface Selection {
  product_id: string;
  provider_product_id: string;
  name: string;
  merchant_key: string;
  merchant_name: string;
  variant_id: string;
  variant_name: string;
  options: { name: string; value: string }[];
  option_ids: string[];
  quantity: number;
  country: string;
  currency: string;
  requires_shipping: boolean;
  delivery_summary: { country: string; postal_prefix: string } | null;
}
export interface PrivatePurchase { email: string; delivery: Delivery | null; offer_code: string | null }
export interface Purchase {
  id: string;
  user_id: string;
  namespace: string;
  operation_key: string;
  input_hash: string;
  selection: Selection;
  private_ciphertext: string | null;
  quote: Quote | null;
  revision: number;
  state: PurchaseState;
  provider_status: string | null;
  checkout_id: string | null;
  checkout_data: Omit<Checkout, "next_action"> | null;
  link_ciphertext: string | null;
  payment_method_id: string | null;
  budget: string | null;
  simulated: boolean;
  reconciliation_required: boolean;
  last_checked_at: Date | null;
  pii_expires_at: Date;
  created_at: Date;
  updated_at: Date;
}
export interface PaymentMethod {
  id: string;
  user_id: string;
  namespace: string;
  enrollment_id: string | null;
  status: string;
  details_ciphertext: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface Operation {
  id: string;
  user_id: string;
  namespace: string;
  kind: ProviderRequest["kind"];
  purchase_id: string | null;
  payment_method_id: string | null;
  logical_key: string;
  idempotency_key: string;
  request_hash: string;
  request_ciphertext: string | null;
  response_ciphertext: string | null;
  provider_id: string | null;
  status: "PREPARED" | "IN_FLIGHT" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  error_code: string | null;
  upstream_code: string | null;
  first_sent_at: Date | null;
  next_attempt_at: Date;
  applied_at: Date | null;
  created_at: Date;
}
