import Fastify from "fastify";
import cors from "@fastify/cors";
import path from "path";
import fs from "fs";
import { loadConfig, getEnabledProjects, loadProjects, buildProjectContext } from "./config.js";
import { getDb } from "./db/index.js";
import { registerApiRoutes, startPoller } from "./routes/api.js";
import { checkTmux } from "./services/tmux.js";
import { resolvePlugin, getPluginName } from "./plugins/loader.js";
import { createLogger } from "./services/logger.js";

const log = createLogger("server");

async function main() {
  // Check required dependencies
  checkTmux();

  const config = loadConfig();
  const projects = loadProjects();

  // Warn about enabled projects whose repos have issues (missing paths, etc.).
  for (const project of projects.filter((p) => p.enabled)) {
    if (project.repos.length === 0) {
      log.warn(`Project "${project.projectId}" declares no repos — skipping`);
    }
    for (const repo of project.repos) {
      if (!fs.existsSync(repo.path)) {
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

  // --- Start the HTTP server BEFORE plugin init. ---
  // Plugin init() shells out to `gh` synchronously (execSync blocks the event
  // loop for several seconds). If we init before listen(), nothing is accepting
  // connections during that window and the dashboard's early /api requests are
  // refused with ECONNREFUSED. Listening first means the socket is open, so any
  // request that lands during init simply queues and is served once init done.
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
  log.info(`📊 Dashboard: http://localhost:${config.port}`)
  log.info(`📡 API: http://localhost:${config.port}/api/status`)

  // Initialize the plugin for each enabled project. The plugin is a singleton
  // per type, so init() must be idempotent per projectId (it populates a
  // per-project cache); calling it once per project is correct.
  const enabledProjects = getEnabledProjects();
  for (const project of enabledProjects) {
    try {
      const plugin = await resolvePlugin(project.projectType);
      const ctx = buildProjectContext(project, createLogger(`plugin:${plugin.name}`));

      log.info(`Initializing plugin "${plugin.name}" for project ${project.projectId}...`)
      await plugin.init(ctx)

      const healthy = await plugin.test(ctx);
      if (!healthy) {
        log.warn(`Plugin "${plugin.name}" health check failed for ${project.projectId} — project may not work correctly`);
      } else {
        log.info(`Plugin "${plugin.name}" initialized and healthy for ${project.projectId}`);
      }
    } catch (err: any) {
      log.error(`Plugin "${project.projectType}" failed to initialize for ${project.projectId}: ${err.message}`);
      project.enabled = false;
      log.warn(`Project "${project.projectId}" has been disabled due to initialization failure`);
    }
  }

  const activeProjects = getEnabledProjects();
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
