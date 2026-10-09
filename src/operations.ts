import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { Database } from "./db.js";
import type { Operation, Provider, ProviderRequest, ProviderResult } from "./domain.js";
import { AppError, asAppError } from "./errors.js";
import { canonical, hash } from "./security.js";

export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
export function replayAllowed(firstSent: Date | null, now = Date.now()): boolean {
  return firstSent === null || now - firstSent.getTime() < IDEMPOTENCY_WINDOW_MS - 60_000;
}

export class Operations {
  constructor(private readonly db: Database, private readonly provider: Provider) {}

  async create(client: PoolClient, userId: string, resourceId: string, logicalKey: string, request: ProviderRequest): Promise<Operation> {
    const id = randomUUID();
    const requestHash = hash(canonical(request));
    const [created] = await this.db.query<Operation>(
      "INSERT INTO operations (id,user_id,namespace,kind,purchase_id,payment_method_id,logical_key,idempotency_key,request_hash,request_ciphertext) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (user_id,namespace,kind,logical_key) DO NOTHING RETURNING *",
      [id, userId, this.db.config.namespace, request.kind, request.kind === "enrollment" ? null : resourceId,
        request.kind === "enrollment" ? resourceId : null, logicalKey, randomUUID(), requestHash,
        this.db.box.seal(request, `operation:${id}:request`)], client,
    );
    if (created) return created;
    const [existing] = await this.db.query<Operation>("SELECT * FROM operations WHERE user_id=$1 AND namespace=$2 AND kind=$3 AND logical_key=$4", [userId, this.db.config.namespace, request.kind, logicalKey], client);
    if (!existing || existing.request_hash !== requestHash) throw new AppError("IDEMPOTENCY_CONFLICT", "This operation key already represents a different immutable request. Recheck the original draft.");
    return existing;
  }

  async run(operation: Operation): Promise<ProviderResult> {
    const [saved] = await this.db.query<Operation>("SELECT * FROM operations WHERE id=$1 AND namespace=$2", [operation.id, this.db.config.namespace]);
    if (!saved) throw new AppError("RECONCILIATION_REQUIRED", "The durable operation is unavailable. Do not submit a replacement.");
    if (saved.status === "SUCCEEDED" && saved.response_ciphertext) return this.db.box.open<ProviderResult>(saved.response_ciphertext, `operation:${saved.id}:response`);
    if (saved.status === "FAILED") throw new AppError(saved.error_code ?? "UPSTREAM_REJECTED", "The provider rejected this operation. Correct the input and prepare a new user-directed draft.", false, saved.upstream_code);
    if (!replayAllowed(saved.first_sent_at) || !saved.request_ciphertext) {
      await this.db.query("UPDATE operations SET status='UNKNOWN',error_code='RECONCILIATION_REQUIRED',next_attempt_at='infinity' WHERE id=$1", [saved.id]);
      throw new AppError("RECONCILIATION_REQUIRED", "The original outcome cannot be safely replayed after the retention window. Reconcile it with Reap; no new checkout will be created.", false, null, true);
    }
    if (saved.next_attempt_at.getTime() > Date.now()) throw new AppError("CHECKOUT_PENDING", "The original operation is waiting for its safe retry window. Recheck its saved status shortly.", true, null, true);
    const request = this.db.box.open<ProviderRequest>(saved.request_ciphertext, `operation:${saved.id}:request`);
    if (hash(canonical(request)) !== saved.request_hash) throw new AppError("RECONCILIATION_REQUIRED", "The stored request failed its integrity check. No request was sent.", false, null, true);
    if (request.kind === "checkout" && await this.db.checkoutBlocked()) throw new AppError("RECONCILIATION_REQUIRED", "Checkout writes were disabled after an approval or contract anomaly. An operator must investigate before any retry.", false, null, true);
    await this.db.query("UPDATE operations SET status='IN_FLIGHT',first_sent_at=COALESCE(first_sent_at,now()) WHERE id=$1", [saved.id]);
    try {
      const response = await this.provider.execute(request, saved.idempotency_key);
      await this.db.query("UPDATE operations SET status='SUCCEEDED',provider_id=$2,response_ciphertext=$3,error_code=NULL,upstream_code=NULL WHERE id=$1", [saved.id, response.value.id, this.db.box.seal(response, `operation:${saved.id}:response`)]);
      return response;
    } catch (error) {
      const failure = asAppError(error);
      const status = failure.retryable || failure.uncertain ? "UNKNOWN" : "FAILED";
      await this.db.query("UPDATE operations SET status=$2,error_code=$3,upstream_code=$4,next_attempt_at=now()+($5*interval '1 millisecond') WHERE id=$1", [saved.id, status, failure.code, failure.upstreamCode, Math.max(5000, failure.retryAfterMs)]);
      throw failure;
    }
  }
}
