import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class CryptoBox {
  constructor(private readonly key: Buffer) {}

  seal(value: unknown, purpose: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  open<T>(sealed: string, purpose: string): T {
    const [version, iv, tag, ciphertext] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new AppError("STORAGE_ERROR", "Stored private data could not be read. Do not reset purchase state.");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8")) as T;
    } catch {
      throw new AppError("STORAGE_ERROR", "Stored private data could not be read. Check the encryption key; do not reset purchase state.");
    }
  }

  sign(value: string): string {
    return createHmac("sha256", this.key).update(value).digest("base64url");
  }

  verify(value: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(value));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

export const opaqueToken = (): string => randomBytes(32).toString("base64url");

export function safeText(value: string, max = 300): string {
  return value.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max).trim();
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? "");
}

export function safeUrl(value: string, config: Config, kind: "hosted" | "catalog" = "hosted"): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError("UPSTREAM_CONTRACT_ERROR", "The provider returned an invalid URL."); }
  const mockLocal = config.mode === "mock" && config.local && url.origin === config.publicUrl.origin;
  const hosts = kind === "hosted" ? config.hostedHosts : config.catalogHosts;
  const allowed = mockLocal || (url.protocol === "https:" && !url.port && hosts.includes(url.hostname)) ||
    (config.mode === "mock" && url.protocol === "https:" && url.origin === config.publicUrl.origin);
  if (!allowed || url.username || url.password || url.hash || value.length > 8192) {
    throw new AppError("UPSTREAM_CONTRACT_ERROR", "The provider URL is not on the configured allowlist. Confirm the host with Reap.");
  }
  return url.href;
}
