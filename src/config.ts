import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AppError } from "./errors.js";

const bool = z.enum(["true", "false"]).default("false").transform((value) => value === "true");
const list = (value: string): string[] => value.split(",").map((entry) => entry.trim()).filter(Boolean);
const decimal = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/;
export const scopes = ["commerce:read", "commerce:prepare", "commerce:checkout", "payment-methods:write"] as const;
export const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const sandboxHosts = new Set(["sg.sandbox.api.reap.global", "mx.sandbox.api.reap.global", "sandbox.api.reap.global"]);

const environment = z.object({
  APP_MODE: z.enum(["mock", "sandbox"]).default("mock"),
  PUBLIC_BASE_URL: z.url().default("http://127.0.0.1:3000"),
  DATABASE_URL: z.string().min(1),
  DATA_ENCRYPTION_KEY: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BIND_HOST: z.string().default("127.0.0.1"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
  ALLOWED_COUNTRIES: z.string().default("US"),
  ALLOWED_CURRENCIES: z.string().default("USD"),
  ALLOWED_MERCHANTS: z.string().default('{"mock-coffee":"Mock Coffee Roasters"}'),
  ALLOW_ALL_MERCHANTS: bool,
  PURCHASE_CAPS: z.string().min(1),
  CATALOG_URL_HOSTS: z.string().default(""),
  REAP_BASE_URL: z.url().default("https://sg.sandbox.api.reap.global"),
  REAP_API_KEY: z.string().default(""),
  REAP_API_VERSION: z.literal("2025-02-14").default("2025-02-14"),
  REAP_PROJECT_REFERENCE: z.string().default(""),
  REAP_HOSTED_URL_HOSTS: z.string().default(""),
  REAP_MONEY_UNIT: z.enum(["unverified", "major", "minor"]).default("unverified"),
  REAP_CHECKOUT_ENABLED: bool,
  REAP_PER_PURCHASE_APPROVAL_CONFIRMED: bool,
  REAP_APPROVAL_VERIFICATION_REF: z.string().max(300).default(""),
  REAP_RETURN_URL_CONFIRMED: bool,
  SANDBOX_SIMULATE_CHECKOUT: bool,
  OAUTH_ISSUER: z.string().default(""),
  OAUTH_AUDIENCE: z.string().default(""),
  OAUTH_JWKS_URI: z.string().default(""),
  OAUTH_METADATA_URL: z.string().default(""),
  OAUTH_SCOPES_CLAIM: z.string().default("scope"),
  OAUTH_EMAIL_CLAIM: z.string().default("email"),
  OAUTH_EMAIL_VERIFIED_CLAIM: z.string().default("email_verified"),
  ALLOWED_SUBJECTS: z.string().default(""),
  ALLOWED_ORIGINS: z.string().default(""),
  LOCAL_DEMO_SUBJECT: z.string().min(1).max(200).default("demo"),
  LOCAL_DEMO_EMAIL: z.string().default("demo@example.invalid"),
  LOCAL_DEMO_EMAIL_VERIFIED: bool,
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(20000),
  STATUS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(5000),
  PII_RETENTION_HOURS: z.coerce.number().int().min(48).max(720).default(72),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  RECOVERY_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  MOCK_SCENARIO: z.enum(["success", "decline", "expired_quote", "changed_price", "rate_limit", "lost_response", "unknown_status", "missing_receipt"]).default("success"),
});

function fail(field: string): never {
  throw new AppError("CONFIG_ERROR", `Invalid or missing ${field}. See .env.example and README; configuration values are not logged.`);
}

export function readEnvironment(): void {
  const path = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(path)) loadEnvFile(path);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = environment.safeParse(env);
  if (!parsed.success) fail(parsed.error.issues.map((issue) => issue.path.join(".")).join(", "));
  const e = parsed.data;
  const publicUrl = new URL(e.PUBLIC_BASE_URL);
  const reapUrl = new URL(e.REAP_BASE_URL);
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") fail("PUBLIC_BASE_URL");
  const local = loopback.has(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !(e.APP_MODE === "mock" && local && loopback.has(e.BIND_HOST))) fail("PUBLIC_BASE_URL (HTTPS is required outside loopback mock mode)");
  if (!sandboxHosts.has(reapUrl.hostname) || reapUrl.protocol !== "https:" || reapUrl.port || reapUrl.username || reapUrl.password || reapUrl.search || reapUrl.hash || reapUrl.pathname !== "/") fail("REAP_BASE_URL (only documented sandbox hosts are allowed)");
  let databaseUrl: URL;
  try { databaseUrl = new URL(e.DATABASE_URL); } catch { fail("DATABASE_URL"); }
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) fail("DATABASE_URL");
  const encryptionKey = Buffer.from(e.DATA_ENCRYPTION_KEY, "base64");
  if (encryptionKey.length !== 32 || encryptionKey.toString("base64") !== e.DATA_ENCRYPTION_KEY) fail("DATA_ENCRYPTION_KEY");
  const countries = list(e.ALLOWED_COUNTRIES);
  const currencies = list(e.ALLOWED_CURRENCIES);
  const isoCurrencies = new Set(Intl.supportedValuesOf("currency"));
  if (!countries.length || countries.some((value) => !/^[A-Z]{2}$/.test(value))) fail("ALLOWED_COUNTRIES");
  if (!currencies.length || currencies.some((value) => !isoCurrencies.has(value))) fail("ALLOWED_CURRENCIES");
  let merchants: Record<string, string>;
  let caps: Record<string, string>;
  try {
    merchants = z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), z.string().trim().min(1).max(150)).parse(JSON.parse(e.ALLOWED_MERCHANTS));
    caps = z.record(z.string(), z.string().regex(decimal)).parse(JSON.parse(e.PURCHASE_CAPS));
  } catch { fail("ALLOWED_MERCHANTS / PURCHASE_CAPS JSON"); }
  if ((!e.ALLOW_ALL_MERCHANTS && !Object.keys(merchants).length) || currencies.some((currency) => !caps[currency] || Number(caps[currency]) <= 0)) fail("PURCHASE_CAPS / ALLOWED_MERCHANTS");
  const hostedHosts = list(e.REAP_HOSTED_URL_HOSTS);
  const catalogHosts = list(e.CATALOG_URL_HOSTS);
  if ([...hostedHosts, ...catalogHosts].some((host) => !/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith("."))) fail("URL host allowlists (exact hostnames only)");
  if (e.APP_MODE === "sandbox") {
    for (const key of ["REAP_API_KEY", "REAP_PROJECT_REFERENCE", "ALLOWED_COUNTRIES", "ALLOWED_CURRENCIES", "ALLOWED_MERCHANTS"] as const) {
      if (!env[key]?.trim()) fail(key);
    }
    if (e.MOCK_SCENARIO !== "success") fail("MOCK_SCENARIO (not available in sandbox)");
  } else if (e.SANDBOX_SIMULATE_CHECKOUT || e.REAP_CHECKOUT_ENABLED) fail("sandbox flags (not available in mock mode)");
  const origins = [publicUrl.origin, ...list(e.ALLOWED_ORIGINS)];
  for (const value of origins) {
    let url: URL;
    try { url = new URL(value); } catch { fail("ALLOWED_ORIGINS"); }
    if (url.origin !== value || (url.protocol !== "https:" && !(local && loopback.has(url.hostname)))) fail("ALLOWED_ORIGINS");
  }
  return {
    mode: e.APP_MODE, publicUrl, local, databaseUrl: e.DATABASE_URL,
    databaseSsl: !loopback.has(databaseUrl.hostname), encryptionKey,
    port: e.PORT, bindHost: e.BIND_HOST, trustProxyHops: e.TRUST_PROXY_HOPS,
    countries, currencies, merchants, allowAllMerchants: e.ALLOW_ALL_MERCHANTS, caps, hostedHosts, catalogHosts, origins,
    namespace: e.APP_MODE === "mock" ? "mock:v1" : `sandbox:${e.REAP_PROJECT_REFERENCE}:${reapUrl.hostname}:${e.REAP_API_VERSION}`,
    reap: { baseUrl: reapUrl.origin, apiKey: e.REAP_API_KEY, version: e.REAP_API_VERSION, moneyUnit: e.REAP_MONEY_UNIT,
      checkoutEnabled: e.REAP_CHECKOUT_ENABLED, approvalConfirmed: e.REAP_PER_PURCHASE_APPROVAL_CONFIRMED,
      approvalVerificationRef: e.REAP_APPROVAL_VERIFICATION_REF, returnUrlConfirmed: e.REAP_RETURN_URL_CONFIRMED,
      simulate: e.SANDBOX_SIMULATE_CHECKOUT },
    oauth: { issuer: e.OAUTH_ISSUER, audience: e.OAUTH_AUDIENCE, jwksUri: e.OAUTH_JWKS_URI,
      metadataUrl: e.OAUTH_METADATA_URL, scopesClaim: e.OAUTH_SCOPES_CLAIM, emailClaim: e.OAUTH_EMAIL_CLAIM,
      emailVerifiedClaim: e.OAUTH_EMAIL_VERIFIED_CLAIM, subjects: list(e.ALLOWED_SUBJECTS) },
    localIdentity: { subject: e.LOCAL_DEMO_SUBJECT, email: e.LOCAL_DEMO_EMAIL,
      emailVerified: e.APP_MODE === "mock" || e.LOCAL_DEMO_EMAIL_VERIFIED },
    upstreamTimeoutMs: e.UPSTREAM_TIMEOUT_MS, statusTimeoutMs: e.STATUS_TIMEOUT_MS,
    piiRetentionHours: e.PII_RETENTION_HOURS, auditRetentionDays: e.AUDIT_RETENTION_DAYS,
    recoveryIntervalMs: e.RECOVERY_INTERVAL_MS, mockScenario: e.MOCK_SCENARIO,
  };
}

export type Config = ReturnType<typeof loadConfig>;

export function assertCheckoutEnabled(config: Config, simulated = config.reap.simulate): void {
  const reap = config.reap;
  if (!reap.checkoutEnabled || reap.moneyUnit === "unverified" || !reap.returnUrlConfirmed || !config.hostedHosts.length ||
    (!simulated && (!reap.approvalConfirmed || !reap.approvalVerificationRef))) {
    throw new AppError("REAP_FEATURE_NOT_ENABLED", "Sandbox checkout is disabled until monetary units, callback behavior, hosted hosts and per-purchase approval are verified for this project. Explicit sandbox simulation is configured separately by the operator.");
  }
}

export function validateRemoteConfig(config: Config): void {
  const { issuer, audience, subjects } = config.oauth;
  if (!issuer || !audience || !subjects.length) fail("OAUTH_ISSUER / OAUTH_AUDIENCE / ALLOWED_SUBJECTS");
  let url: URL;
  try { url = new URL(issuer); } catch { fail("OAUTH_ISSUER"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("OAUTH_ISSUER");
  if (audience !== new URL("/mcp", config.publicUrl).href) fail("OAUTH_AUDIENCE (must exactly match PUBLIC_BASE_URL/mcp)");
}
