import type { IssueSourcePlugin } from "../types/plugin.js";

const registry = new Map<string, IssueSourcePlugin>();

/**
 * Resolve a plugin by type name.
 * - "github" → built-in plugin bundled with talos-loop
 * - other    → try @talos-loop/source-<type>, then treat as local path
 */
export async function resolvePlugin(type: string): Promise<IssueSourcePlugin> {
  const cached = registry.get(type);
  if (cached) return cached;

  let plugin: IssueSourcePlugin;

  if (type === "github") {
    const mod = await import("./github/index.js");
    plugin = new mod.GitHubIssueSourcePlugin();
  } else {
    // Try external npm package first, then local path
    let resolved: any;
    try {
      resolved = require(`@talos-loop/source-${type}`);
    } catch {
      resolved = require(type);
    }
    plugin = resolved.default || resolved;
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

/** Clear the registry (useful for testing) */
export function clearRegistry(): void {
  registry.clear();
}
