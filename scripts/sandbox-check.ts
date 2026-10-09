import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadConfig, readEnvironment, type Config } from "../src/config.js";
import { AppError, asAppError } from "../src/errors.js";
import { money } from "../src/money.js";
import { ReapProvider } from "../src/providers/reap.js";
import { inputSchemas } from "../src/schemas.js";

const checkInput = inputSchemas.search_products.omit({ cursor: true }).extend({
  product_id: z.string().min(1).max(8192).optional(),
  option_ids: z.array(z.string().min(1).max(300)).max(20).optional(),
});

export async function checkSandbox(config: Config, input: unknown, fetcher: typeof fetch = fetch) {
  if (config.mode !== "sandbox") throw new AppError("CONFIG_ERROR", "sandbox:check requires APP_MODE=sandbox; mock results cannot verify the API.");
  const parsed = checkInput.safeParse(input);
  if (!parsed.success) throw new AppError("INVALID_INPUT", "Check query, country, currency, limit, product ID and option IDs.");
  const { product_id, option_ids, merchant_preference, ...criteria } = parsed.data;
  if (!config.countries.includes(criteria.country) || !config.currencies.includes(criteria.currency)) {
    throw new AppError("UNSUPPORTED_REGION_OR_MERCHANT", "Choose a configured country and currency.");
  }
  if (criteria.max_item_price) {
    try { money(criteria.max_item_price, criteria.currency); }
    catch { throw new AppError("INVALID_INPUT", "Use the currency's supported decimal precision."); }
  }
  const merchant = merchant_preference && (config.allowAllMerchants ? merchant_preference : config.merchants[merchant_preference]);
  if (merchant_preference && !merchant) throw new AppError("UNSUPPORTED_REGION_OR_MERCHANT", "Choose a configured merchant key.");
  if (option_ids && !product_id) throw new AppError("INVALID_INPUT", "Supply the exact product ID when checking option IDs.");
  const provider = new ReapProvider(config, fetcher);
  const search = await provider.search({ query: criteria.query, country: criteria.country, currency: criteria.currency, limit: criteria.limit,
    ...(criteria.max_item_price ? { max_item_price: criteria.max_item_price } : {}), ...(merchant ? { merchant } : {}) });
  const products = search.products.filter((product) => config.allowAllMerchants || Object.values(config.merchants).some((name) => name.toLowerCase() === product.merchant.toLowerCase()));
  const id = product_id ?? products[0]?.id;
  const details = id ? await provider.details(id) : null;
  if (details && !config.allowAllMerchants && !Object.values(config.merchants).some((name) => name.toLowerCase() === details.merchant.toLowerCase())) {
    throw new AppError("UNSUPPORTED_REGION_OR_MERCHANT", "The diagnostic product is outside the merchant allowlist.");
  }
  if (details && option_ids) {
    const known = details.options.flatMap((group) => group.values.map((value) => value.option_id));
    if (new Set(option_ids).size !== option_ids.length || option_ids.some((id) => !known.includes(id)) ||
      details.options.some((group) => group.values.filter((value) => option_ids.includes(value.option_id)).length !== 1)) {
      throw new AppError("INVALID_INPUT", "Use exactly one returned option ID per group for this product.");
    }
  }
  const variant = details && option_ids ? await provider.variant(details.id, option_ids) : null;
  return {
    mode: config.mode, simulated: false, read_only: true,
    verified: ["search", ...(details ? ["details"] : []), ...(variant ? ["variant"] : [])],
    products: products.map(({ id, name, merchant, price_range, available }) => ({ provider_product_id: id, name, merchant, price_range, available })),
    has_next_page: search.next_cursor !== null, warnings: search.warnings,
    details, variant,
    purchase_flow: {
      status: "NOT_TESTED", message: "This command never creates enrollments, quotes or checkouts and never starts recovery. Verify purchases separately through MCP with explicit approval.",
      prerequisites: {
        email_verified: config.localIdentity.emailVerified,
        hosted_hosts_configured: config.hostedHosts.length > 0,
        monetary_units_configured: config.reap.moneyUnit !== "unverified",
        callback_confirmed: config.reap.returnUrlConfirmed,
        checkout_enabled: config.reap.checkoutEnabled,
        hosted_approval_confirmed: config.reap.approvalConfirmed && Boolean(config.reap.approvalVerificationRef),
        checkout_simulation: config.reap.simulate,
      },
    },
  };
}

const usage = "Usage: npm run sandbox:check -- --query coffee --country US --currency USD [--limit 1-10] [--merchant KEY] [--max-item-price AMOUNT] [--product-id ID --option-id ID ...]";

export function parseCheckArgs(args: string[]) {
  try {
    return parseArgs({ args, options: {
      help: { type: "boolean" }, query: { type: "string" }, country: { type: "string" }, currency: { type: "string" },
      limit: { type: "string" }, merchant: { type: "string" }, "max-item-price": { type: "string" }, "product-id": { type: "string" },
      "option-id": { type: "string", multiple: true },
    } }).values;
  } catch { throw new AppError("INVALID_INPUT", `Unrecognized or incomplete arguments. ${usage}`); }
}

async function main(): Promise<void> {
  const values = parseCheckArgs(process.argv.slice(2));
  if (values.help) {
    console.log(`${usage}\nRequires sandbox environment configuration. Read-only API calls; no database access, recovery, enrollment, quote or checkout writes. Provider product IDs are diagnostic IDs, not MCP product IDs.`);
    return;
  }
  readEnvironment();
  const config = loadConfig();
  const result = await checkSandbox(config, {
    query: values.query, country: values.country, currency: values.currency,
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    ...(values.merchant ? { merchant_preference: values.merchant } : {}),
    ...(values["max-item-price"] ? { max_item_price: values["max-item-price"] } : {}),
    ...(values["product-id"] ? { product_id: values["product-id"] } : {}),
    ...(values["option-id"] ? { option_ids: values["option-id"] } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const failure = asAppError(error);
    console.error(JSON.stringify({ ok: false, code: failure.code, message: failure.message, upstream_code: failure.upstreamCode, trace_id: failure.traceId }));
    process.exitCode = 1;
  });
}
