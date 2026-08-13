import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appCacheDir: vi.fn(async () => "/tmp"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));

import { invoke } from "@tauri-apps/api/core";
import { ancestorDirs } from "./launch";
import {
  debugPythonPath,
  moduleNameForScript,
  normalizePythonPath,
  pythonCandidates,
  remoteTracerDir,
  venvBinaryCandidates,
} from "./session";

const SSH = { kind: "ssh", host: "gpubox" } as const;
const WINDOWS_SSH = {
  kind: "ssh",
  host: "winbox",
  platform: "windows",
} as const;
const LOCAL = { kind: "local" } as const;

describe("pythonCandidates", () => {
  it("checks POSIX venv layouts first", () => {
    expect(pythonCandidates("/proj", SSH)).toEqual([
      "/proj/.venv/bin/python",
      "/proj/venv/bin/python",
    ]);
  });

  it("adds Windows venv layouts only for local workspaces", () => {
    const local = pythonCandidates("/proj", LOCAL);
    expect(local).toContain("/proj/.venv/Scripts/python.exe");
    expect(local).toContain("/proj/venv/Scripts/python.exe");
    expect(local.slice(0, 2)).toEqual(pythonCandidates("/proj", SSH));
  });

  it("uses Windows venv layouts for Windows SSH workspaces", () => {
    expect(pythonCandidates("C:\\repo", WINDOWS_SSH)).toContain(
      "C:\\repo\\.venv\\Scripts\\python.exe",
    );
  });
});

describe("debugPythonPath", () => {
  it("prepends the effective project root for debuggee imports", () => {
    expect(debugPythonPath("/proj")).toBe("/proj");
  });
});

describe("moduleNameForScript", () => {
  it("derives a module name for scripts under the project root", () => {
    expect(moduleNameForScript("/proj/training_modular/run.py", "/proj")).toBe(
      "training_modular.run",
    );
  });

  it("does not derive a module for scripts outside the project root", () => {
    expect(moduleNameForScript("/other/run.py", "/proj")).toBeNull();
  });
});

describe("remoteTracerDir", () => {
  it("puts the tracer under the remote home cache", () => {
    expect(remoteTracerDir("/home/adam")).toBe("/home/adam/.cache/terax/debug");
  });

  it("tolerates a trailing slash in the home path", () => {
    expect(remoteTracerDir("/home/adam/")).toBe(
      "/home/adam/.cache/terax/debug",
    );
  });

  it("builds a Windows remote tracer path", () => {
    expect(remoteTracerDir("C:\\Users\\adam", "windows")).toBe(
      "C:\\Users\\adam\\.cache\\terax\\debug",
    );
  });
});

describe("venvBinaryCandidates", () => {
  it("probes POSIX then Windows layouts, tolerating trailing slashes", () => {
    expect(venvBinaryCandidates("/proj/.venv/")).toEqual([
      "/proj/.venv/bin/python",
      "/proj/.venv/bin/python3",
      "/proj/.venv/Scripts/python.exe",
    ]);
  });
});

describe("normalizePythonPath", () => {
  it("resolves a pasted venv directory to the binary inside it", async () => {
    vi.mocked(invoke).mockImplementation(async (_cmd, args) => {
      const path = (args as { path: string }).path;
      if (path === "/g/.venv") return { kind: "dir" };
      if (path === "/g/.venv/bin/python") return { kind: "file" };
      throw new Error("not found");
    });
    expect(await normalizePythonPath("/g/.venv", LOCAL)).toBe(
      "/g/.venv/bin/python",
    );
  });

  it("passes real binary paths through untouched", async () => {
    vi.mocked(invoke).mockImplementation(async () => ({ kind: "file" }));
    expect(await normalizePythonPath("/usr/bin/python3", LOCAL)).toBe(
      "/usr/bin/python3",
    );
  });

  it("leaves unresolvable paths alone (error surfaces at spawn)", async () => {
    vi.mocked(invoke).mockImplementation(async () => {
      throw new Error("not found");
    });
    expect(await normalizePythonPath("/nope", LOCAL)).toBe("/nope");
  });
});

describe("ancestorDirs", () => {
  it("walks nearest-first from the script's directory", () => {
    expect(ancestorDirs("/home/adam/proj/src/train.py")).toEqual([
      "/home/adam/proj/src",
      "/home/adam/proj",
      "/home/adam",
      "/home",
    ]);
  });

  it("stops at the walk cap", () => {
    const deep = `/${Array.from({ length: 30 }, (_, i) => `d${i}`).join("/")}/f.py`;
    expect(ancestorDirs(deep, 5)).toHaveLength(5);
  });

  it("handles files directly under the root", () => {
    expect(ancestorDirs("/train.py")).toEqual([]);
  });
});
