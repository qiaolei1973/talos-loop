import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadProjects, getEnabledProjects, getProjectById, loadConfig, resetConfigCache } from "../config.js";

let tmpProjects: string;
let tmpConfig: string;

beforeEach(() => {
  tmpProjects = path.join(os.tmpdir(), `tl-projects-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  tmpConfig = path.join(os.tmpdir(), `tl-config-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  process.env.PROJECTS_PATH = tmpProjects;
  process.env.CONFIG_PATH = tmpConfig;
  fs.writeFileSync(tmpConfig, JSON.stringify({ port: 3100 }));
  resetConfigCache();
});

afterEach(() => {
  delete process.env.PROJECTS_PATH;
  delete process.env.CONFIG_PATH;
  resetConfigCache();
  for (const f of [tmpProjects, tmpConfig]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe("loadProjects()", () => {
  it("parses projects with repos (name=basename, remote override honored)", () => {
    fs.writeFileSync(
      tmpProjects,
      JSON.stringify([
        {
          projectId: "owner/1",
          projectType: "github",
          enabled: true,
          repos: [{ path: "/abs/path/my-repo", remote: "owner/my-repo" }],
        },
      ]),
    );
    const projects = loadProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].projectId).toBe("owner/1");
    expect(projects[0].repos[0].name).toBe("my-repo");
    expect(projects[0].repos[0].remote).toBe("owner/my-repo");
  });

  // Issue #28: repos[].branch (baseline branch) is passed through verbatim; the
  // consumer applies the "main" default, so unset stays undefined here.
  it("passes repos[].branch through (undefined when omitted)", () => {
    fs.writeFileSync(
      tmpProjects,
      JSON.stringify([
        {
          projectId: "owner/1",
          projectType: "github",
          repos: [
            { path: "/x/repo-default" },
            { path: "/x/repo-master", branch: "master" },
          ],
        },
      ]),
    );
    const repos = loadProjects()[0].repos;
    expect(repos[0].branch).toBeUndefined();
    expect(repos[1].branch).toBe("master");
  });

  it("defaults enabled to true when omitted", () => {
    fs.writeFileSync(
      tmpProjects,
      JSON.stringify([{ projectId: "owner/1", projectType: "github", repos: [{ path: "/x/r", remote: "owner/r" }] }]),
    );
    expect(loadProjects()[0].enabled).toBe(true);
  });

  // Issue #32: stages is the stage→skill map (e.g. "ready" → github-code). It
  // defaults to {} when a project declares none (no dispatch for that project).
  it("parses the stage→skill map (stages), defaulting to {} when omitted", () => {
    fs.writeFileSync(
      tmpProjects,
      JSON.stringify([
        { projectId: "a/1", projectType: "github", repos: [{ path: "/x/r", remote: "a/r" }], stages: { ready: "github-code", "in-review": "github-review" } },
        { projectId: "b/2", projectType: "github", repos: [{ path: "/x/r2", remote: "b/r2" }] },
      ]),
    );
    const projects = loadProjects();
    expect(projects[0].stages).toEqual({ ready: "github-code", "in-review": "github-review" });
    expect(projects[1].stages).toEqual({});
  });

  it("returns [] when projects.json is missing", () => {
    // beforeEach never writes tmpProjects, so it's already absent — the
    // "missing file" path is what we want to exercise.
    expect(loadProjects()).toEqual([]);
  });

  it("caches results (resetConfigCache forces re-read)", () => {
    fs.writeFileSync(tmpProjects, JSON.stringify([{ projectId: "owner/1", projectType: "github", repos: [] }]));
    expect(loadProjects()).toHaveLength(1);
    fs.writeFileSync(tmpProjects, JSON.stringify([]));
    // cached → still 1
    expect(loadProjects()).toHaveLength(1);
    resetConfigCache();
    expect(loadProjects()).toEqual([]);
  });
});

describe("getEnabledProjects()", () => {
  it("filters out disabled projects and projects with no repos", () => {
    fs.writeFileSync(
      tmpProjects,
      JSON.stringify([
        { projectId: "a/1", projectType: "github", enabled: true, repos: [{ path: "/x/r", remote: "a/r" }] },
        { projectId: "b/2", projectType: "github", enabled: false, repos: [{ path: "/x/r", remote: "b/r" }] },
        { projectId: "c/3", projectType: "github", enabled: true, repos: [] },
      ]),
    );
    expect(getEnabledProjects().map((p) => p.projectId)).toEqual(["a/1"]);
  });
});

describe("getProjectById()", () => {
  it("looks up by projectId", () => {
    fs.writeFileSync(
      tmpProjects,
      JSON.stringify([{ projectId: "owner/1", projectType: "github", enabled: true, repos: [{ path: "/x/r", remote: "owner/r" }] }]),
    );
    expect(getProjectById("owner/1")?.projectType).toBe("github");
    expect(getProjectById("nope/9")).toBeUndefined();
  });
});

describe("loadConfig()", () => {
  // Issue #32: maxRetry caps the auto `claude -r` retries for a crashed coding
  // session. Default 1.
  it("defaults maxRetry to 1 when omitted", () => {
    // beforeEach writes { port: 3100 } to tmpConfig — no maxRetry.
    expect(loadConfig().maxRetry).toBe(1);
  });

  it("parses maxRetry from config.json when provided", () => {
    fs.writeFileSync(tmpConfig, JSON.stringify({ port: 3100, maxRetry: 3 }));
    resetConfigCache();
    expect(loadConfig().maxRetry).toBe(3);
  });

  // Issue #26: keepSessionOnSuccess opts out of auto-killing completed sessions.
  it("defaults keepSessionOnSuccess to false when omitted", () => {
    // beforeEach writes { port: 3100 } — no keepSessionOnSuccess.
    expect(loadConfig().keepSessionOnSuccess).toBe(false);
  });

  it("parses keepSessionOnSuccess from config.json when provided", () => {
    fs.writeFileSync(tmpConfig, JSON.stringify({ port: 3100, keepSessionOnSuccess: true }));
    resetConfigCache();
    expect(loadConfig().keepSessionOnSuccess).toBe(true);
  });
});
