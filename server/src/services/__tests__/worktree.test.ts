import { describe, it, expect } from "vitest";
import { worktreePath } from "../worktree.js";

describe("worktreePath derivation (issue #21)", () => {
  it("derives a stable path under the repo's sibling .talos-worktrees dir", () => {
    const p = worktreePath("/home/agent/talos-loop", "tl-github-talos-loop-9");
    expect(p).toBe("/home/agent/.talos-worktrees/tl-github-talos-loop-9");
  });

  it("is deterministic: same repo + session always resolves to the same path", () => {
    const a = worktreePath("/repos/foo", "tl-github-foo-7");
    const b = worktreePath("/repos/foo", "tl-github-foo-7");
    expect(a).toBe(b);
  });

  it("separates distinct issues into distinct paths (the session name carries the id)", () => {
    const one = worktreePath("/repos/foo", "tl-github-foo-7");
    const two = worktreePath("/repos/foo", "tl-github-foo-8");
    expect(one).not.toBe(two);
  });

  it("normalizes a relative/inner repo path before resolving the sibling dir", () => {
    // path.resolve collapses the "." so the sibling dir lands next to the repo,
    // not nested inside it.
    const p = worktreePath("/home/agent/talos-loop/.", "tl-x");
    expect(p).toBe("/home/agent/.talos-worktrees/tl-x");
  });
});
