import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadProjects, getEnabledProjects, getProjectById, resetConfigCache } from "../config.js";

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

  it("defaults enabled to true when omitted", () => {
    fs.writeFileSync(
      tmpProjects,
      JSON.stringify([{ projectId: "owner/1", projectType: "github", repos: [{ path: "/x/r", remote: "owner/r" }] }]),
    );
    expect(loadProjects()[0].enabled).toBe(true);
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
