import Fastify from "fastify";
import cors from "@fastify/cors";
import { promises as fsp } from "fs";
import path from "path";
import { loadConfig, getEnabledProjects, loadProjects } from "./config.js";
import { getDb } from "./db/index.js";
import { registerApiRoutes, startPoller } from "./routes/api.js";
import { checkTmux } from "./services/tmux.js";
import { getPluginName } from "./plugins/loader.js";
import { createLogger } from "./services/logger.js";

const log = createLogger("server");

async function main() {
  // Check required dependencies
  await checkTmux();

  const config = await loadConfig();
  const projects = await loadProjects();

  // Warn about enabled projects whose repos have issues (missing paths, etc.).
  for (const project of projects.filter((p) => p.enabled)) {
    if (project.repos.length === 0) {
      log.warn(`Project "${project.projectId}" declares no repos — skipping`);
    }
    for (const repo of project.repos) {
      try {
        await fsp.access(repo.path);
      } catch {
        log.warn(`Project "${project.projectId}": repo "${repo.name}" path does not exist: ${repo.path}`);
      }
      if (!repo.remote) {
        log.warn(`Project "${project.projectId}": repo "${repo.name}" has no resolvable remote (owner/repo)`);
      }
    }
  }

  // Initialize DB (handles old-schema cleanup)
  getDb();
  log.info(`SQLite initialized at ${config.dbPath}`);

  // --- Start the HTTP server. ---
  // (The plugin's project metadata is resolved lazily inside list()/writeLabel(),
  // so there is no blocking init pass at startup — issue #32.)
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  // API routes
  await registerApiRoutes(app);

  // Health check
  app.get("/api/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // Serve static dashboard
  const webDir = path.join(__dirname, "../dist/web");
  try {
    await fsp.access(path.join(webDir, "index.html"));
  } catch {
    log.warn(`Frontend not built — run: cd web && npx vite build`);
    log.warn(`Serving API-only mode at http://localhost:${config.port}`);
  }

  try {
    const fastifyStatic = (await import("@fastify/static")).default;
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: "/",
      wildcard: false,
    });
    // SPA fallback
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api")) {
        try {
          const html = await fsp.readFile(path.join(webDir, "index.html"), "utf-8");
          return reply.type("text/html").send(html);
        } catch {
          return reply.code(404).send({ error: "not found" });
        }
      }
      return reply.code(404).send({ error: "not found" });
    });
  } catch {
    // @fastify/static not available — API-only mode
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });
  log.info(`🚀 Talos Loop running on http://localhost:${config.port}`);
  log.info(`📊 Dashboard: http://localhost:${config.port}`)
  log.info(`📡 API: http://localhost:${config.port}/api/status`)

  const activeProjects = await getEnabledProjects();
  log.info(`⏱  Polling every ${config.pollInterval / 1000}s for ${activeProjects.length} project(s)`);
  log.info(`Projects:`);
  for (const project of activeProjects) {
    const name = await getPluginName(project.projectType);
    log.info(`  - ${name} (${project.projectId})`);
  }
  log.info(`Repos:`);
  const seenRepos = new Set<string>();
  for (const project of activeProjects) {
    for (const repo of project.repos) {
      if (seenRepos.has(repo.name)) continue;
      seenRepos.add(repo.name);
      log.info(`  - ${repo.name} (${repo.path})${repo.remote ? ` → ${repo.remote}` : ""}`);
    }
  }

  // Start the poller
  startPoller();
  log.info("Poller started. First poll will run immediately.");
}

main().catch((err) => {
  log.error(`Fatal error: ${err}`);
  process.exit(1);
});
