import { discoverAuthorization } from "./auth.js";
import { loadConfig, readEnvironment } from "./config.js";
import { asAppError, log } from "./errors.js";
import { createHttpApp } from "./http.js";
import { createRuntime } from "./runtime.js";

async function main(): Promise<void> {
  readEnvironment();
  const config = loadConfig();
  const authorization = await discoverAuthorization(config);
  const runtime = await createRuntime(config);
  const http = createHttpApp(runtime.commerce, { ...authorization, remote: true });
  const server = http.app.listen(config.port, config.bindHost, () => log("server_ready", { mode: config.mode, transport: "http", port: config.port }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await http.close();
    await runtime.close();
  };
  server.on("error", () => { log("http_listen_failed"); process.exitCode = 1; void stop(); });
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}
main().catch((error: unknown) => {
  const failure = asAppError(error);
  log("startup_failed", { code: failure.code, trace_id: failure.traceId });
  process.stderr.write(`${failure.message}\n`);
  process.exitCode = 1;
});
