import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { Config } from "./config.js";
import type { Actor, Identity, PaymentMethod, Purchase } from "./domain.js";
import { AppError, log } from "./errors.js";
import { CryptoBox, hash } from "./security.js";

export class Database {
  readonly pool: Pool;
  readonly box: CryptoBox;
  private readonly context = new AsyncLocalStorage<PoolClient>();

  constructor(readonly config: Config) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      ...(config.databaseSsl ? { ssl: { rejectUnauthorized: true } } : {}),
      max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
      statement_timeout: 30000, application_name: "reap-mcp",
    });
    this.box = new CryptoBox(config.encryptionKey);
    this.pool.on("error", () => log("database_pool_error"));
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = [], client?: PoolClient): Promise<T[]> {
    return (await (client ?? this.context.getStore() ?? this.pool).query<T>(sql, values)).rows;
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>, supplied?: PoolClient): Promise<T> {
    const existing = supplied ?? this.context.getStore();
    const client = existing ?? await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.context.run(client, () => work(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!existing) client.release();
    }
  }

  async locked<T>(key: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const existing = this.context.getStore();
    const client = existing ?? await this.pool.connect();
    const lockKey = key === "schema-migrations" ? "reap-mcp:schema-migrations" : `${this.config.namespace}:${key}`;
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [lockKey]);
      locked = result.rows[0]?.locked === true;
      if (!locked) throw new AppError("OPERATION_PENDING", "Another request is working on this resource. Recheck the saved state shortly; do not prepare a duplicate purchase.", true);
      return await this.context.run(client, () => work(client));
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      if (!existing) client.release();
    }
  }

  async actor(identity: Identity): Promise<Actor> {
    const id = randomUUID();
    const [row] = await this.query<{ id: string; owner_reference: string }>(
      "INSERT INTO users (id, issuer, subject, owner_reference) VALUES ($1,$2,$3,$4) ON CONFLICT (issuer,subject) DO UPDATE SET last_seen_at=now() RETURNING id,owner_reference",
      [id, identity.issuer, identity.subject, `reap_mcp_${id}`],
    );
    if (!row) throw new Error("Missing user record");
    if (identity.email && identity.emailVerified) {
      await this.query("UPDATE users SET profile_ciphertext=$2 WHERE id=$1", [row.id, this.box.seal({ email: identity.email, emailVerified: true }, `user:${row.id}`)]);
    }
    return { ...identity, id: row.id, ownerReference: row.owner_reference };
  }

  async purchase(id: string, userId: string, client?: PoolClient): Promise<Purchase> {
    const [row] = await this.query<Purchase>("SELECT * FROM purchases WHERE id=$1 AND user_id=$2 AND namespace=$3", [id, userId, this.config.namespace], client);
    if (!row) throw new AppError("FORBIDDEN", "This purchase is unavailable to the authenticated user.");
    return row;
  }

  async payment(id: string, userId: string, client?: PoolClient): Promise<PaymentMethod> {
    const [row] = await this.query<PaymentMethod>("SELECT * FROM payment_methods WHERE id=$1 AND user_id=$2 AND namespace=$3", [id, userId, this.config.namespace], client);
    if (!row) throw new AppError("FORBIDDEN", "This payment method is unavailable to the authenticated user.");
    return row;
  }

  async audit(userId: string | null, tool: string, outcome: string, traceId: string, resourceId: string | null = null, differences: Record<string, string | number | boolean | null> = {}, client?: PoolClient): Promise<void> {
    const allowed = new Set(["previous_state", "state", "previous_revision", "revision", "previous_amount", "amount", "currency"]);
    await this.query("INSERT INTO audit_events (user_id,namespace,resource_id,tool,outcome,trace_id,differences) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [userId, this.config.namespace, resourceId, tool, outcome, traceId, JSON.stringify(Object.fromEntries(Object.entries(differences).filter(([key]) => allowed.has(key))))], client);
  }

  async rateLimit(userId: string): Promise<void> {
    const [row] = await this.query<{ requests: number }>("INSERT INTO rate_windows (key,window_start,requests) VALUES ($1,date_trunc('minute',now()),1) ON CONFLICT (key,window_start) DO UPDATE SET requests=rate_windows.requests+1 RETURNING requests", [hash(`${this.config.namespace}:${userId}`)]);
    if (!row || row.requests > 60) throw new AppError("RATE_LIMITED", "Too many tool calls. Wait until the next minute before checking again.", true);
  }

  async blockCheckout(reason: string): Promise<void> {
    await this.query("INSERT INTO provider_controls (namespace,checkout_blocked,reason,blocked_at) VALUES ($1,true,$2,now()) ON CONFLICT (namespace) DO UPDATE SET checkout_blocked=true,reason=EXCLUDED.reason,blocked_at=now()", [this.config.namespace, reason]);
  }

  async checkoutBlocked(): Promise<boolean> {
    const [row] = await this.query<{ checkout_blocked: boolean }>("SELECT checkout_blocked FROM provider_controls WHERE namespace=$1", [this.config.namespace]);
    return row?.checkout_blocked === true;
  }

  async migrate(): Promise<void> {
    await this.locked("schema-migrations", async (client) => {
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
      const directory = new URL("../migrations/", import.meta.url);
      const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
      for (const name of files) {
        const sql = await readFile(new URL(name, directory), "utf8");
        const [existing] = await this.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE name=$1", [name], client);
        if (existing) {
          if (existing.checksum !== hash(sql)) throw new AppError("MIGRATION_ERROR", "An applied migration changed. Restore it and add a new migration instead.");
          continue;
        }
        await this.transaction(async (tx) => {
          await tx.query(sql);
          await tx.query("INSERT INTO schema_migrations (name,checksum) VALUES ($1,$2)", [name, hash(sql)]);
        }, client);
      }
    });
  }

  async close(): Promise<void> { await this.pool.end(); }
}
