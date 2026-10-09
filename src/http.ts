import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { challenge, resourceMetadata, type AuthorizationMetadata, type TokenVerifier } from "./auth.js";
import { Commerce, requiredScopes } from "./commerce.js";
import type { Identity } from "./domain.js";
import { AppError, asAppError, log } from "./errors.js";
import { buildMcpServer, isToolName } from "./mcp.js";
import { MockProvider } from "./providers/mock.js";
import { escapeHtml, hash, opaqueToken } from "./security.js";

const css = `:root{font-family:system-ui,sans-serif;color:#182821;background:#f5f5f0;color-scheme:light}body{margin:0;padding:32px 20px}main{max-width:620px;margin:6vh auto;background:white;padding:32px;border:1px solid #d8dfd9;border-radius:12px}h1{font-size:1.7rem;margin-top:24px}p{line-height:1.6}small{display:block;color:#536259;margin-top:24px}.badge{display:inline-block;background:#fff2ce;padding:6px 10px;border-radius:5px;font-size:.8rem;font-weight:700}button{font:inherit;padding:12px 18px;border-radius:6px;border:1px solid #21593e;cursor:pointer;margin:8px 8px 0 0;background:#21593e;color:white}button.secondary{background:white;color:#21593e}button:focus-visible,a:focus-visible{outline:3px solid #b46013;outline-offset:4px}dl{display:grid;grid-template-columns:1fr 1fr;gap:12px}dd{text-align:right;margin:0}hr{border:0;border-top:1px solid #d8dfd9;margin:24px 0}.total{font-size:1.25rem;font-weight:700}@media(max-width:480px){main{padding:22px;margin:2vh auto}button{width:100%;margin-right:0}dl{font-size:.95rem}}`;

function page(title: string, message: string, content = "", simulated = true): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} | Reap MCP</title><link rel="stylesheet" href="/style.css"></head><body><main><header>Reap MCP</header><p class="badge">${simulated ? "MOCK / SIMULATED — NO REAL PURCHASE" : "REAP SANDBOX"}</p><h1>${escapeHtml(title)}</h1><p role="status">${escapeHtml(message)}</p>${content}<small>Temporary links are private. Do not share them. No card details are collected by this application.</small></main></body></html>`;
}
function cookie(request: Request, name: string): string | null {
  const entry = request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  return entry?.slice(name.length + 1) ?? null;
}
function bearer(request: Request): string | null {
  const value = request.headers.authorization;
  return typeof value === "string" ? /^Bearer ([^\s]+)$/i.exec(value)?.[1] ?? null : null;
}

export function createHttpApp(commerce: Commerce, options: { verifier?: TokenVerifier; metadata?: AuthorizationMetadata; remote: boolean }) {
  const config = commerce.config;
  if (options.remote && !options.verifier) throw new AppError("CONFIG_ERROR", "Remote HTTP commerce requires an OAuth token verifier. Local demo identity is never accepted on HTTP.");
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxyHops) app.set("trust proxy", config.trustProxyHops);
  const limits = new Map<string, { count: number; expires: number }>();
  app.use((request, response, next) => {
    response.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    if (config.publicUrl.protocol === "https:") response.setHeader("Strict-Transport-Security", "max-age=31536000");
    if (request.headers.host?.toLowerCase() !== config.publicUrl.host.toLowerCase()) { response.status(403).json({ error: "invalid_host" }); return; }
    const origin = request.get("origin");
    if (origin && !config.origins.includes(origin)) { response.status(403).json({ error: "invalid_origin" }); return; }
    if (!config.local && !request.secure) { response.status(400).json({ error: "https_required" }); return; }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Protocol-Version");
    }
    const now = Date.now();
    if (limits.size > 1000) for (const [key, value] of limits) if (value.expires <= now) limits.delete(key);
    const key = request.socket.remoteAddress ?? "unknown";
    const old = limits.get(key);
    const value = old && old.expires > now ? old : { count: 0, expires: now + 60000 };
    if (++value.count > 180 || (!old && limits.size >= 10000)) { response.setHeader("Retry-After", "60"); response.status(429).json({ error: "rate_limited" }); return; }
    limits.set(key, value);
    next();
  });
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(express.urlencoded({ extended: false, limit: "4kb", parameterLimit: 5 }));
  app.get("/style.css", (_request, response) => { response.type("css").send(css); });
  app.get("/health", async (_request, response) => {
    await commerce.db.query("SELECT 1");
    response.json({ ok: true, mode: config.mode });
  });
  app.get("/", (_request, response) => {
    const message = options.remote
      ? "Connect your assistant to the authenticated /mcp endpoint. Purchase state is available through the five MCP tools."
      : "Connect your assistant through stdio as described in the README. This server provides browser callback pages. The HTTP /mcp endpoint is disabled in this process.";
    response.type("html").send(page("MCP commerce, not a shopping app", message, "", config.mode === "mock"));
  });

  const authenticate = async (request: Request): Promise<Identity> => {
    const token = bearer(request);
    if (!token || !options.verifier) throw new AppError("AUTH_REQUIRED", "Authenticate through the configured OAuth provider.");
    return options.verifier.verify(token);
  };
  const optionalIdentity = async (request: Request): Promise<Identity | undefined> => request.headers.authorization ? authenticate(request) : undefined;
  const handler = createMcpHandler(({ authInfo }) => {
    const identity = authInfo?.extra?.identity as Identity | undefined;
    if (!identity) throw new AppError("AUTH_REQUIRED", "Authenticated identity is required.");
    return buildMcpServer(commerce, identity);
  }, { responseMode: "json" });
  const node = toNodeHandler(handler);

  if (options.remote) {
    app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_request, response) => { response.json(resourceMetadata(config)); });
    app.get("/.well-known/oauth-authorization-server", (_request, response) => {
      if (!options.metadata) { response.status(503).json({ error: "authorization_metadata_unavailable" }); return; }
      response.json(options.metadata);
    });
    app.options("/mcp", (_request, response) => {
      response.set({ "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id" }).sendStatus(204);
    });
    app.all("/mcp", async (request, response) => {
      const identity = await authenticate(request);
      const call = request.body as { method?: string; params?: { name?: string } } | undefined;
      if (call?.method === "tools/call" && typeof call.params?.name === "string" && isToolName(call.params.name)) {
        const required = requiredScopes[call.params.name];
        if (!identity.scopes.includes(required)) {
          response.setHeader("WWW-Authenticate", challenge(config, "insufficient_scope", required));
          response.status(403).json({ error: "insufficient_scope" });
          return;
        }
      }
      Object.assign(request, { auth: { token: bearer(request)!, clientId: identity.subject, scopes: [...identity.scopes], resource: new URL(config.oauth.audience), extra: { identity } } });
      await node(request, response, request.body);
    });
  } else app.all("/mcp", (_request, response) => { response.status(503).json({ error: "remote_mcp_disabled", message: "This process serves browser callback pages only. Use stdio, or start the OAuth-configured HTTP entry point." }); });

  app.get("/status/:purchaseId", async (request, response) => {
    const identity = await authenticate(request);
    if (!identity.scopes.includes("commerce:read")) throw new AppError("FORBIDDEN", "The commerce:read scope is required.");
    const result = await commerce.call("get_purchase_status", { purchase_id: request.params.purchaseId }, identity);
    response.type("html").send(page(result.status, result.next_action?.message ?? "Read the verified result in your assistant.", "", result.simulated));
  });
  for (const kind of ["payment-method", "purchase"] as const) {
    app.get(`/callbacks/${kind}`, async (request, response) => {
      const reference = typeof request.query.ref === "string" ? request.query.ref : "";
      const result = await commerce.callback(reference, kind, await optionalIdentity(request));
      const titles: Record<string, string> = { ACTIVE: "Card connected", REQUIRES_ACTION: "Waiting for approval", PROCESSING: "Processing", COMPLETED: "Provider reports completion", FAILED: "The attempt failed", EXPIRED: "This attempt expired", READY: "No checkout submitted" };
      const title = titles[result.status] ?? "Verification is still pending";
      const message = result.data?.reconciliation_required ? "The provider result needs reconciliation. Return to your assistant; do not submit another purchase." :
        result.status === "COMPLETED" ? "Return to your assistant and call get_purchase_status for the verified result and order reference. This page itself is not proof of payment." :
        "Return to your assistant to continue. Refreshing this page only checks the existing resource; it never submits another purchase.";
      const refresh = `<form method="get"><input type="hidden" name="ref" value="${escapeHtml(reference)}"><button type="submit" class="secondary">Check status again</button></form>`;
      response.type("html").send(page(title, message, refresh, result.simulated));
    });
  }

  if (config.mode === "mock" && commerce.provider instanceof MockProvider) {
    const provider = commerce.provider;
    for (const [route, kind] of [["enrollment", "enrollment"], ["approval", "checkout"]] as const) {
      const verify = async (request: Request) => {
        const token = String(request.params.token);
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError("FORBIDDEN", "This temporary link is invalid or expired.");
        const resource = await provider.inspect(token, kind);
        const reference = resource.callback ? new URL(resource.callback).searchParams.get("ref") ?? "" : "";
        await commerce.verifyCallback(reference, kind === "enrollment" ? "payment-method" : "purchase", await optionalIdentity(request));
        return { token, resource };
      };
      app.get(`/mock/${route}/:token`, async (request, response) => {
        const { token, resource } = await verify(request);
        const value = resource.value;
        if (value.status !== "REQUIRES_ACTION") { response.type("html").send(page("This simulation has already been handled", "Return to your assistant and check the existing resource. No additional purchase will be submitted.")); return; }
        const nonce = opaqueToken();
        const cookieName = `reap_mock_${hash(token).slice(0, 12)}`;
        response.cookie(cookieName, nonce, { httpOnly: true, sameSite: "strict", secure: config.publicUrl.protocol === "https:", maxAge: 15 * 60000, path: "/mock/" });
        const csrf = commerce.db.box.sign(`consent:${kind}:${token}:${nonce}`);
        const b = resource.quote?.breakdown;
        const format = (value: { amount: string; currency: string } | null | undefined) => value ? escapeHtml(`${value.amount} ${value.currency}`) : "Unknown (not zero)";
        const amounts = b ? `<dl><dt>Items</dt><dd>${format(b.items_subtotal)}</dd><dt>Shipping</dt><dd>${format(b.shipping)}</dd><dt>Tax${b.tax?.included_in_prices === true ? " (included)" : ""}</dt><dd>${format(b.tax?.amount)}</dd><dt>Discounts</dt><dd>${b.discounts.map((item) => `${escapeHtml(item.name)}: ${format(item.amount)}`).join("; ") || "None supplied"}</dd><dt>Additional charges</dt><dd>${b.additional_charges.map((item) => `${escapeHtml(item.name)}: ${format(item.amount)}`).join("; ") || "None supplied"}</dd><dt class="total">Simulated total</dt><dd class="total">${format(b.final_amount)}</dd></dl>` : "";
        const form = `<form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit" name="decision" value="approve">${kind === "enrollment" ? "Connect a simulated card" : "Approve simulated purchase"}</button><button type="submit" class="secondary" name="decision" value="decline">Decline</button></form>`;
        response.type("html").send(page(kind === "enrollment" ? "Simulate card setup" : "Review the simulated purchase", "This is a local mock, not Reap's payment page. No money moves and no merchant order is placed. Your explicit click advances only this simulation.", amounts + form));
      });
      app.post(`/mock/${route}/:token`, async (request, response) => {
        const { token } = await verify(request);
        const nonce = cookie(request, `reap_mock_${hash(token).slice(0, 12)}`);
        const body = request.body as { csrf?: unknown; decision?: unknown };
        if (request.get("origin") !== config.publicUrl.origin || !nonce || typeof body?.csrf !== "string" ||
          !commerce.db.box.verify(`consent:${kind}:${token}:${nonce}`, body.csrf) || !["approve", "decline"].includes(String(body.decision))) {
          throw new AppError("FORBIDDEN", "The simulation form expired or failed its origin/CSRF check. Open the original link again.");
        }
        const callback = new URL(await provider.consent(token, kind, body.decision === "approve"));
        if (callback.origin !== config.publicUrl.origin || !["/callbacks/payment-method", "/callbacks/purchase"].includes(callback.pathname)) throw new AppError("FORBIDDEN", "The callback destination is invalid.");
        response.redirect(303, callback.href);
      });
    }
  }
  app.use((_request, response) => { response.status(404).type("html").send(page("Page not found", "Return to your assistant and use the original temporary link.", "", config.mode === "mock")); });
  const errors: ErrorRequestHandler = (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const failure = asAppError(error);
    log("http_error", { code: failure.code, trace_id: failure.traceId });
    if (response.headersSent) { response.end(); return; }
    const httpCode = failure.code === "AUTH_REQUIRED" ? 401 : failure.code === "FORBIDDEN" ? 403 : (error as { status?: number })?.status === 413 ? 413 : error instanceof SyntaxError ? 400 : 503;
    if (httpCode === 401) response.setHeader("WWW-Authenticate", challenge(config));
    response.status(httpCode).type("html").send(page(httpCode === 401 ? "Sign-in required" : "Unable to verify this request", failure.code === "INTERNAL_ERROR" ? "Return to your assistant and check the saved operation. No success was inferred." : failure.message, "", config.mode === "mock"));
  };
  app.use(errors);
  return { app, close: () => handler.close() };
}
