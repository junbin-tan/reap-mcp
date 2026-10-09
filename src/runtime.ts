import type { Config } from "./config.js";
import { scopes } from "./config.js";
import { Commerce } from "./commerce.js";
import { Database } from "./db.js";
import type { Identity } from "./domain.js";
import { asAppError, log } from "./errors.js";
import { MockProvider } from "./providers/mock.js";
import { ReapProvider } from "./providers/reap.js";

export function localIdentity(config: Config): Identity {
  return { issuer: "urn:reap-mcp:local", subject: config.localIdentity.subject, scopes: [...scopes],
    email: config.localIdentity.email, emailVerified: config.localIdentity.emailVerified };
}

export async function createRuntime(config: Config) {
  const db = new Database(config);
  try { await db.query("SELECT name FROM schema_migrations LIMIT 1"); }
  catch (error) { await db.close(); throw error; }
  const provider = config.mode === "mock" ? new MockProvider(db, config) : new ReapProvider(config);
  const commerce = new Commerce(db, provider, config);
  let running = false;
  let work: Promise<void> = Promise.resolve();
  const tick = () => {
    if (running) return;
    running = true;
    work = commerce.recover().then(() => undefined).catch((error: unknown) => {
      const failure = asAppError(error);
      log("recovery_unavailable", { code: failure.code, trace_id: failure.traceId });
    }).finally(() => { running = false; });
  };
  const timer = setInterval(tick, config.recoveryIntervalMs);
  timer.unref();
  tick();
  let closed = false;
  return { db, commerce, async close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    await work;
    await db.close();
  } };
}
