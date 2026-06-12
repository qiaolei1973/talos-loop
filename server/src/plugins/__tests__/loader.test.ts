import { describe, it, expect, beforeEach } from "vitest";
import { resolvePlugin, clearRegistry } from "../loader.js";

describe("Plugin Loader", () => {
  beforeEach(() => {
    clearRegistry();
  });

  it("should resolve built-in github plugin", async () => {
    const plugin = await resolvePlugin("github");
    expect(plugin).toBeDefined();
    expect(plugin.name).toBe("github");
  });

  it("should cache plugin instances", async () => {
    const a = await resolvePlugin("github");
    const b = await resolvePlugin("github");
    expect(a).toBe(b);
  });

  it("should throw for unknown external plugin", async () => {
    await expect(resolvePlugin("nonexistent-plugin-xyz")).rejects.toThrow();
  });
});
