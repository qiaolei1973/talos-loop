import type { IssueSourcePlugin, PluginSchema } from "../types/plugin.js";

const registry = new Map<string, IssueSourcePlugin>();

/**
 * Resolve a plugin by type name.
 * - "github" → built-in plugin bundled with talos-loop
 * - other    → an npm package name or local path (resolved directly)
 */
export async function resolvePlugin(type: string): Promise<IssueSourcePlugin> {
  const cached = registry.get(type);
  if (cached) return cached;

  let plugin: IssueSourcePlugin;

  if (type === "github") {
    const mod = await import("./github/index.js");
    plugin = new mod.GitHubIssueSourcePlugin();
  } else {
    // type is the package name (e.g. "@acme/source-jira") or a local path.
    // Plugins conventionally export a class (like the built-in github plugin),
    // but may also export a ready instance — instantiate classes accordingly.
    // require() loads ESM-built plugins natively on Node >= 22.12; plugins must
    // not use top-level await. (Switching to `await import()` is a no-op here:
    // tsc lowers it back to require under module:commonjs, and it breaks
    // directory/package specifiers under tsx.)
    const resolved: any = require(type);
    const exported = resolved.default || resolved;
    plugin = typeof exported === "function" ? new exported() : exported;
  }

  registry.set(type, plugin);
  return plugin;
}

/** Get a previously loaded plugin (throws if not loaded) */
export function getPluginSync(type: string): IssueSourcePlugin {
  const plugin = registry.get(type);
  if (!plugin) throw new Error(`Plugin "${type}" not loaded. Call resolvePlugin() first.`);
  return plugin;
}

/**
 * Resolve a plugin's display name (alias) for a given source type (package name).
 * Falls back to the type itself if the plugin can't be resolved (e.g. config drift).
 */
export async function getPluginName(type: string): Promise<string> {
  try {
    return (await resolvePlugin(type)).name;
  } catch {
    return type;
  }
}

/**
 * Aggregate schemas from all loaded plugins. Each plugin contributes its
 * `schema()` result keyed by its type name (e.g. "jira", "github").
 * Only plugins currently in the registry are included — unused plugins
 * don't need settings.
 */
export function getPluginSchemas(): Record<string, PluginSchema> {
  const schemas: Record<string, PluginSchema> = {};
  for (const [type, plugin] of registry.entries()) {
    if (plugin.schema) {
      schemas[type] = plugin.schema();
    }
  }
  return schemas;
}

/** Clear the registry (useful for testing) */
export function clearRegistry(): void {
  registry.clear();
}
