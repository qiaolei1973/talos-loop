import Fastify from "fastify";
import cors from "@fastify/cors";
import path from "path";
import fs from "fs";
import { loadConfig } from "./config.js";
import { getDb } from "./db/index.js";
import { registerApiRoutes, startPoller } from "./routes/api.js";
import { checkTmux } from "./services/tmux.js";
import { getEnabledSources } from "./config.js";
import { resolvePlugin } from "./plugins/loader.js";
import { createLogger } from "./services/logger.js";

const log = createLogger("server");

async function main() {
  // Check required dependencies
  checkTmux();

  const config = loadConfig();

  // Initialize DB (handles old schema cleanup)
  getDb();
  log.info(`SQLite initialized at ${config.dbPath}`);

  // Initialize plugins for each enabled source
  const sources = getEnabledSources();
  for (const source of sources) {
    try {
      const plugin = await resolvePlugin(source.type);
      const ctx = { config: source.config, logger: createLogger(`plugin:${source.type}`) };

      log.info(`Initializing plugin "${source.type}"...`);
      await plugin.init(ctx);

      const healthy = await plugin.test(ctx);
      if (!healthy) {
        log.warn(`Plugin "${source.type}" health check failed — source may not work correctly`);
      } else {
        log.info(`Plugin "${source.type}" initialized and healthy`);
      }
    } catch (err: any) {
      log.error(`Plugin "${source.type}" failed to initialize: ${err.message}`);
      source.enabled = false;
      log.warn(`Source "${source.type}" has been disabled due to initialization failure`);
    }
  }

  const enabledSources = sources.filter((s) => s.enabled);

  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  // API routes
  await registerApiRoutes(app);

  // Health check
  app.get("/api/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // Serve static dashboard
  const webDir = path.join(__dirname, "../dist/web");
  if (!fs.existsSync(webDir) || !fs.existsSync(path.join(webDir, "index.html"))) {
    log.warn(`Frontend not built — run: cd web && npx vite build`);
    log.warn(`Serving API-only mode at http://localhost:${config.port}`);
  } else {
    const fastifyStatic = (await import("@fastify/static")).default;
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: "/",
      wildcard: false,
    });
    // SPA fallback
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api")) {
        return reply.type("text/html").send(fs.readFileSync(path.join(webDir, "index.html")));
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });
  log.info(`🚀 Talos Loop running on http://localhost:${config.port}`);
  log.info(`📊 Dashboard: http://localhost:${config.port}`);
  log.info(`📡 API: http://localhost:${config.port}/api/status`);
  log.info(`⏱  Polling every ${config.pollInterval / 1000}s for ${enabledSources.length} source(s)`);
  log.info(`Sources:`);
  for (const source of enabledSources) {
    log.info(`  - ${source.type} (enabled: ${source.enabled})`);
  }
  log.info(`Repos:`);
  for (const repo of config.repos) {
    log.info(`  - ${repo.name} (${repo.path})`);
  }

  // Start the poller
  startPoller();
  log.info("Poller started. First poll will run immediately.");
}

main().catch((err) => {
  log.error(`Fatal error: ${err}`);
  process.exit(1);
});
