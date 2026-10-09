import { loadConfig, readEnvironment } from "./config.js";
import { Database } from "./db.js";
import { asAppError, log } from "./errors.js";

readEnvironment();
const db = new Database(loadConfig());
try {
  await db.migrate();
  log("migrations_applied");
} catch (error) {
  const failure = asAppError(error);
  log("migration_failed", { code: failure.code, trace_id: failure.traceId });
  process.exitCode = 1;
} finally {
  await db.close();
}
