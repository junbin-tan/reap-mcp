import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, readEnvironment } from "./config.js";
import { asAppError, log } from "./errors.js";
import { createHttpApp } from "./http.js";
import { buildMcpServer } from "./mcp.js";
import { createRuntime, localIdentity } from "./runtime.js";

async function main(): Promise<void> {
  readEnvironment();
  const config = loadConfig();
  const runtime = await createRuntime(config);
  const http = createHttpApp(runtime.commerce, { remote: false });
  const pages = http.app.listen(config.port, config.bindHost, () => log("pages_ready", { mode: config.mode, transport: "stdio", port: config.port }));
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    pages.close();
    await http.close();
    await runtime.close();
  };
  const handle = serveStdio(() => {
    const server = buildMcpServer(runtime.commerce, localIdentity(config));
    server.onclose = () => { void cleanup(); };
    return server;
  });
  const stop = async () => { await handle.close(); await cleanup(); };
  pages.on("error", () => { log("pages_listen_failed"); process.exitCode = 1; void stop(); });
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  log("server_ready", { mode: config.mode, transport: "stdio" });
}
main().catch((error: unknown) => {
  const failure = asAppError(error);
  log("startup_failed", { code: failure.code, trace_id: failure.traceId });
  process.stderr.write(`${failure.message}\n`);
  process.exitCode = 1;
});
