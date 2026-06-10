import Fastify from "fastify";
import cors from "@fastify/cors";
import path from "path";
import fs from "fs";
import { loadConfig } from "./config.js";
import { getDb } from "./db/index.js";
import { registerApiRoutes, startPoller } from "./routes/api.js";
import { ensureLabels } from "./services/dispatcher.js";
import { getEnabledRepos } from "./config.js";

async function main() {
  const config = loadConfig();

  // Initialize DB
  getDb();
  console.log(`[db] SQLite initialized at ${config.dbPath}`);

  // Ensure GitHub labels exist for all repos
  const repos = getEnabledRepos();
  for (const repo of repos) {
    console.log(`[labels] Ensuring labels for ${repo.github}...`);
    await ensureLabels(repo.github);
  }

  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  // API routes
  await registerApiRoutes(app);

  // Health check
  app.get("/api/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // Serve static dashboard
  const webDir = path.join(__dirname, "../dist/web");
  if (!fs.existsSync(webDir) || !fs.existsSync(path.join(webDir, "index.html"))) {
    console.warn(`[dev] Frontend not built — run: cd web && npx vite build`);
    console.warn(`[dev] Serving API-only mode at http://localhost:${config.port}`);
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
  console.log(`\n🚀 Talos Loop running on http://localhost:${config.port}`);
  console.log(`📊 Dashboard: http://localhost:${config.port}`);
  console.log(`📡 API: http://localhost:${config.port}/api/status`);
  console.log(`⏱  Polling every ${config.pollInterval / 1000}s for ${repos.length} repo(s)`);
  console.log(`\nRepos:`);
  for (const repo of repos) {
    console.log(`  - ${repo.github} (${repo.path})`);
  }
  console.log();

  // Start the poller
  startPoller();
  console.log("[poller] Started. First poll will run immediately.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
