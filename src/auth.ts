import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { scopes, validateRemoteConfig, type Config } from "./config.js";
import type { Identity } from "./domain.js";
import { AppError } from "./errors.js";

export interface TokenVerifier { verify(token: string): Promise<Identity> }
export interface AuthorizationMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
  registration_endpoint?: string;
  code_challenge_methods_supported: string[];
  [key: string]: unknown;
}

export class JwtVerifier implements TokenVerifier {
  constructor(private readonly config: Config, private readonly keys: JWTVerifyGetKey) {}

  async verify(token: string): Promise<Identity> {
    if (token.length > 16384) throw new AppError("AUTH_REQUIRED", "The access token is invalid. Reconnect through the authorization provider.");
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.oauth.issuer, audience: this.config.oauth.audience,
        algorithms: ["RS256", "ES256"], requiredClaims: ["exp", "sub", "iss", "aud"],
      });
      if (typeof payload.sub !== "string" || !this.config.oauth.subjects.includes(payload.sub)) throw new AppError("FORBIDDEN", "This account is not on the application's demo-user allowlist.");
      const rawScopes = payload[this.config.oauth.scopesClaim];
      const granted = typeof rawScopes === "string" ? rawScopes.split(/\s+/) : Array.isArray(rawScopes) ? rawScopes.filter((value): value is string => typeof value === "string") : [];
      const rawEmail = payload[this.config.oauth.emailClaim];
      const email = typeof rawEmail === "string" && z.email().safeParse(rawEmail).success ? rawEmail : null;
      return { issuer: this.config.oauth.issuer, subject: payload.sub, scopes: granted,
        email, emailVerified: email !== null && payload[this.config.oauth.emailVerifiedClaim] === true };
    } catch (error) {
      if (error instanceof AppError && error.code === "FORBIDDEN") throw error;
      throw new AppError("AUTH_REQUIRED", "The access token is missing, invalid, expired or intended for another resource. Reconnect through the authorization provider.");
    }
  }
}

export function resourceMetadata(config: Config): Record<string, unknown> {
  return { resource: new URL("/mcp", config.publicUrl).href, authorization_servers: [config.oauth.issuer],
    scopes_supported: [...scopes], bearer_methods_supported: ["header"], resource_name: "Reap MCP sandbox commerce" };
}

export function challenge(config: Config, error = "invalid_token", required?: string): string {
  return `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", config.publicUrl).href}", error="${error}"${required ? `, scope="${required}"` : ""}`;
}

export async function discoverAuthorization(config: Config, fetcher: typeof fetch = fetch): Promise<{ verifier: TokenVerifier; metadata: AuthorizationMetadata }> {
  validateRemoteConfig(config);
  const issuer = new URL(config.oauth.issuer);
  const metadataUrl = config.oauth.metadataUrl || new URL("/.well-known/oauth-authorization-server", issuer).href;
  const url = new URL(metadataUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hostname !== issuer.hostname) throw new AppError("CONFIG_ERROR", "OAuth metadata must come from the configured HTTPS issuer host.");
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new AppError("CONFIG_ERROR", "OAuth metadata could not be loaded. Configure OAUTH_METADATA_URL with your provider's discovery document.");
  const content = await response.text();
  if (content.length > 65536) throw new AppError("CONFIG_ERROR", "OAuth metadata exceeded the size limit.");
  const schema = z.object({
    issuer: z.url(), authorization_endpoint: z.url(), token_endpoint: z.url(), jwks_uri: z.url().optional(), registration_endpoint: z.url().optional(),
    code_challenge_methods_supported: z.array(z.string()), client_id_metadata_document_supported: z.boolean().optional(),
  }).passthrough();
  const parsed = schema.safeParse(JSON.parse(content));
  if (!parsed.success || parsed.data.issuer !== config.oauth.issuer || !parsed.data.code_challenge_methods_supported.includes("S256")) {
    throw new AppError("CONFIG_ERROR", "OAuth discovery must match the configured issuer and support authorization code with S256 PKCE.");
  }
  const metadata = parsed.data;
  if (!metadata.registration_endpoint && !metadata.client_id_metadata_document_supported) throw new AppError("CONFIG_ERROR", "Enable MCP-compatible client registration (CIMD or DCR) at the authorization provider.");
  const jwks = config.oauth.jwksUri || metadata.jwks_uri;
  if (!jwks) throw new AppError("CONFIG_ERROR", "Set OAUTH_JWKS_URI to the provider's documented signing-key endpoint.");
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint, jwks].filter((value): value is string => Boolean(value))) {
    const target = new URL(endpoint);
    if (target.protocol !== "https:" || target.username || target.password) throw new AppError("CONFIG_ERROR", "OAuth endpoints must use HTTPS without URL credentials.");
  }
  if (!config.oauth.jwksUri && new URL(jwks).hostname !== issuer.hostname) throw new AppError("CONFIG_ERROR", "Confirm the cross-host JWKS endpoint explicitly through OAUTH_JWKS_URI.");
  return { verifier: new JwtVerifier(config, createRemoteJWKSet(new URL(jwks), { timeoutDuration: 5000 })), metadata };
}
