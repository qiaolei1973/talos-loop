import Fastify from "fastify";
import cors from "@fastify/cors";
import path from "path";
import fs from "fs";
import { loadConfig } from "./config.js";
import { getDb } from "./db/index.js";
import { registerApiRoutes, startPoller } from "./routes/api.js";
import { checkTmux } from "./services/tmux.js";
import { getEnabledRepos } from "./config.js";
import { createLogger } from "./services/logger.js";

const log = createLogger("server");

async function main() {
  // Check required dependencies
  checkTmux();

  const config = loadConfig();

  // Initialize DB
  getDb();
  log.info(`SQLite initialized at ${config.dbPath}`);

  const repos = getEnabledRepos();

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
  log.info(`⏱  Polling every ${config.pollInterval / 1000}s for ${repos.length} repo(s)`);
  log.info(`Repos:`);
  for (const repo of repos) {
    log.info(`  - ${repo.github} (${repo.path})`);
  }

  // Start the poller
  startPoller();
  log.info("Poller started. First poll will run immediately.");
}

main().catch((err) => {
  log.error(`Fatal error: ${err}`);
  process.exit(1);
});
