import { z } from "zod";
import { purchaseStates } from "./domain.js";

const id = z.uuid().describe("An opaque local ID returned by this server, belonging to the authenticated user.");
const text = (max: number) => z.string().trim().min(1).max(max);
export const decimalSchema = z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,6})?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const country = z.string().regex(/^[A-Z]{2}$/);
const optionId = text(300);
export const addressSchema = z.strictObject({
  recipient_name: text(200).optional(), first_name: text(100).optional(), last_name: text(100).optional(),
  line1: text(200).optional(), line2: text(200).optional(), city: text(100).optional(), region: text(100).optional(),
  postal_code: text(32).optional(), country: country.optional(), phone: text(32).optional(),
});
export const createSchema = z.strictObject({
  action: z.literal("create"), product_id: id, quantity: z.number().int().min(1).max(10),
  option_ids: z.array(optionId).max(20).optional(), country, currency,
  contact_email: z.email().max(254).optional(), shipping_address: addressSchema.optional(),
  max_total: decimalSchema.optional(), offer_code: text(128).optional(),
  operation_key: text(128).regex(/^[A-Za-z0-9_-]+$/).describe("Reuse this stable key for retries of the same logical preparation. Use a new key only for a new user-directed draft."),
});
export const shippingSchema = z.strictObject({
  action: z.literal("select_shipping"), purchase_id: id, expected_revision: z.number().int().min(1), shipping_option_id: optionId,
});
export const inputSchemas = {
  connect_payment_method: z.strictObject({ payment_method_id: id.optional() }),
  search_products: z.strictObject({
    query: text(300), country, currency, max_item_price: decimalSchema.optional(),
    merchant_preference: text(64).optional(), limit: z.number().int().min(1).max(10).default(5), cursor: id.optional(),
  }),
  prepare_purchase: z.discriminatedUnion("action", [createSchema, shippingSchema]),
  request_purchase: z.strictObject({ purchase_id: id, expected_revision: z.number().int().min(1), payment_method_id: id }),
  get_purchase_status: z.strictObject({ purchase_id: id }),
};
export type ToolName = keyof typeof inputSchemas;
export type CreateInput = z.infer<typeof createSchema>;
export type ShippingInput = z.infer<typeof shippingSchema>;
export type SearchInput = z.infer<typeof inputSchemas.search_products>;

export const moneySchema = z.strictObject({ amount: z.string().regex(/^-?\d+(\.\d+)?$/), currency });
export const nextActionSchema = z.strictObject({ type: text(64), message: text(500), url: z.url().optional(), retry_after_seconds: z.number().int().min(1).optional() });
export const needsInputSchema = z.strictObject({
  required_fields: z.array(z.strictObject({
    field: text(100), reason: text(300),
    choices: z.array(z.strictObject({ id: text(300), label: text(300), available: z.boolean().nullable() })).optional(),
  })),
});
export type NeededField = z.infer<typeof needsInputSchema>["required_fields"][number];
const merchantSchema = z.strictObject({ key: text(64), name: text(150) });
const selectedOptionsSchema = z.array(z.strictObject({ name: text(150), value: text(300) }));
const redirectFields = { approval_url: z.url().nullable(), approval_expires_at: z.string().nullable() };
export const paymentDataSchema = z.strictObject({
  payment_method_id: id.nullable(), enrollment_status: text(100), setup_url: z.url().nullable(),
  setup_expires_at: z.string().nullable(), masked_label: z.string().nullable(),
});
export const searchDataSchema = z.strictObject({
  products: z.array(z.strictObject({
    product_id: id, name: text(300), merchant: merchantSchema,
    availability: z.enum(["AVAILABLE", "UNAVAILABLE", "UNKNOWN"]), image_url: z.url().nullable(),
    price_range: z.strictObject({ min: moneySchema, max: moneySchema }),
    preview_variant: z.strictObject({ name: z.string(), price: moneySchema, available: z.boolean().nullable() }).nullable(),
  })),
  warnings: z.array(z.string().max(500)), next_cursor: id.nullable(), pricing: z.literal("INDICATIVE"),
});
const chargeSchema = z.strictObject({ name: z.string(), amount: moneySchema });
export const quoteDataSchema = z.strictObject({
  expires_at: z.string(),
  shipping_options: z.array(z.strictObject({
    id: text(300), name: text(300), selected: z.boolean(), price: moneySchema,
    details: z.array(z.strictObject({ key: z.string(), value: z.string() })),
  })),
  breakdown: z.strictObject({
    items_subtotal: moneySchema, shipping: moneySchema.nullable(),
    tax: z.strictObject({ amount: moneySchema, included_in_prices: z.boolean().nullable() }).nullable(),
    discounts: z.array(chargeSchema), additional_charges: z.array(chargeSchema), final_amount: moneySchema,
  }),
});
export const purchaseDataSchema = z.strictObject({
  purchase_id: id, revision: z.number().int().min(0), state: z.enum(purchaseStates), provider_status: z.string().nullable(),
  product: z.strictObject({ product_id: id, name: z.string(), merchant: merchantSchema,
    variant_name: z.string(), selected_options: selectedOptionsSchema }),
  quantity: z.number().int(), country, currency,
  delivery_summary: z.strictObject({ country, postal_prefix: z.string() }).nullable(),
  quote: quoteDataSchema.nullable(),
  budget: z.strictObject({ max_total: moneySchema.nullable(), server_cap: moneySchema.nullable(), within_budget: z.boolean().nullable() }),
  ...redirectFields,
  charged_amount: moneySchema.nullable(), order_reference: z.string().nullable(),
  last_checked_at: z.string().nullable(), reconciliation_required: z.boolean(), warnings: z.array(z.string()),
});

function envelope(data: z.ZodType) {
  return z.strictObject({
    ok: z.boolean(), mode: z.enum(["mock", "sandbox"]), simulated: z.boolean(), status: text(100),
    data: data.nullable(), next_action: nextActionSchema.nullable(),
    error: z.strictObject({ code: text(100), message: text(500), retryable: z.boolean(), trace_id: z.uuid() }).optional(),
  });
}
export const outputSchemas = {
  connect_payment_method: envelope(z.union([paymentDataSchema, needsInputSchema])),
  search_products: envelope(searchDataSchema),
  prepare_purchase: envelope(z.union([purchaseDataSchema, needsInputSchema])),
  request_purchase: envelope(purchaseDataSchema),
  get_purchase_status: envelope(purchaseDataSchema),
};
export interface Envelope {
  ok: boolean;
  mode: "mock" | "sandbox";
  simulated: boolean;
  status: string;
  data: Record<string, unknown> | null;
  next_action: z.infer<typeof nextActionSchema> | null;
  error?: { code: string; message: string; retryable: boolean; trace_id: string };
}
