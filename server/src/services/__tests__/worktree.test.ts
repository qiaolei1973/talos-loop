import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock execAsync from utils — createWorktree now calls execAsync instead of execSync.
vi.mock("../../utils/execAsync.js", () => ({
  execAsync: vi.fn(),
}));

import { execAsync } from "../../utils/execAsync.js";
import { worktreePath, createWorktree } from "../worktree.js";

const mockExecAsync = execAsync as unknown as ReturnType<typeof vi.fn>;

function mockResolved() {
  return Promise.resolve({ stdout: "", stderr: "" });
}

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

describe("createWorktree (issue #28: baseline branch)", () => {
  beforeEach(() => {
    mockExecAsync.mockReset();
    mockExecAsync.mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("fetches the remote base, then adds the worktree from origin/<baseBranch>", async () => {
    await createWorktree("/repos/foo", "/repos/.talos-worktrees/s1", "feat/issue-9", "master");

    const cmds = mockExecAsync.mock.calls.map((c: any[]) => c[0] as string);
    // fetch must precede the worktree add, and both reference the base branch.
    const fetchIdx = cmds.findIndex((c) => c.includes("fetch origin") && c.includes('"master"'));
    const addIdx = cmds.findIndex((c) => c.includes("worktree add -b"));
    expect(fetchIdx, "expected a git fetch of the base branch").toBeGreaterThanOrEqual(0);
    expect(addIdx, "expected a git worktree add").toBeGreaterThan(fetchIdx);
    // The feat branch is cut from origin/<baseBranch>, not local HEAD.
    expect(cmds[addIdx]).toBe('git -C "/repos/foo" worktree add -b "feat/issue-9" "/repos/.talos-worktrees/s1" "origin/master"');
  });

  it("defaults are the caller's job — createWorktree uses exactly the baseBranch passed", async () => {
    await createWorktree("/repos/foo", "/wt/s2", "feat/issue-1", "main");
    const cmds = mockExecAsync.mock.calls.map((c: any[]) => c[0] as string);
    expect(cmds.some((c) => c === 'git -C "/repos/foo" fetch origin "main"')).toBe(true);
    expect(cmds.some((c) => c.endsWith('worktree add -b "feat/issue-1" "/wt/s2" "origin/main"'))).toBe(true);
  });

  it("still best-effort cleans a stale worktree/branch before branching", async () => {
    await createWorktree("/repos/foo", "/wt/s3", "feat/issue-2", "main");
    const cmds = mockExecAsync.mock.calls.map((c: any[]) => c[0] as string);
    expect(cmds.some((c) => c.includes("worktree remove --force"))).toBe(true);
    expect(cmds.some((c) => c.includes("branch -D"))).toBe(true);
  });

  it("propagates a fetch failure so the caller can skip the dispatch", async () => {
    // Cleanup commands are swallowed; only the fetch (and add) throw.
    mockExecAsync.mockImplementation((cmd: string) => {
      if (cmd.includes("fetch origin")) return Promise.reject(new Error("fatal: couldn't find remote ref main"));
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    await expect(createWorktree("/repos/foo", "/wt/s4", "feat/issue-3", "main")).rejects.toThrow(
      /couldn't find remote ref/,
    );
    // The worktree add must NOT have run once the fetch failed.
    const cmds = mockExecAsync.mock.calls.map((c: any[]) => c[0] as string);
    expect(cmds.some((c) => c.includes("worktree add -b"))).toBe(false);
  });
});
