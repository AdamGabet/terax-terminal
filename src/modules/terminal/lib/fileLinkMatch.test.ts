import { describe, expect, it } from "vitest";
import { findFileLinkMatches, resolveFileLinkPath } from "./fileLinkMatch";

const LOCAL = { kind: "local" } as const;
const SSH = { kind: "ssh", host: "box" } as const;

describe("findFileLinkMatches", () => {
  it("matches a bare image filename in ls output", () => {
    const m = findFileLinkMatches("screenshot.png  notes.txt  chart.pdf");
    expect(m.map((x) => x.text)).toEqual(["screenshot.png", "chart.pdf"]);
    expect(m[0].index).toBe(0);
  });

  it("matches relative and absolute paths", () => {
    const m = findFileLinkMatches("see ./img/logo.svg and /tmp/out.pdf");
    expect(m.map((x) => x.text)).toEqual(["./img/logo.svg", "/tmp/out.pdf"]);
  });

  it("stops at grep-style :line suffix", () => {
    const m = findFileLinkMatches("assets/a.png:12: match");
    expect(m.map((x) => x.text)).toEqual(["assets/a.png"]);
  });

  it("ignores non-previewable extensions and urls inside quotes", () => {
    expect(findFileLinkMatches("main.rs build.log")).toEqual([]);
  });

  it("matches uppercase extensions", () => {
    const m = findFileLinkMatches("PHOTO.PNG");
    expect(m.map((x) => x.text)).toEqual(["PHOTO.PNG"]);
  });
});

describe("resolveFileLinkPath", () => {
  it("keeps absolute paths and normalizes segments", () => {
    expect(resolveFileLinkPath("/a/b/../c.png", null, LOCAL, null)).toBe(
      "/a/c.png",
    );
  });

  it("joins relative paths against the cwd", () => {
    expect(resolveFileLinkPath("img/x.pdf", "/home/u/proj", LOCAL, null)).toBe(
      "/home/u/proj/img/x.pdf",
    );
    expect(
      resolveFileLinkPath("./img/x.pdf", "/home/u/proj", LOCAL, null),
    ).toBe("/home/u/proj/img/x.pdf");
    expect(resolveFileLinkPath("../x.png", "/home/u/proj", LOCAL, null)).toBe(
      "/home/u/x.png",
    );
  });

  it("returns null for relative paths without a cwd", () => {
    expect(resolveFileLinkPath("x.png", null, LOCAL, null)).toBeNull();
  });

  it("expands ~ with the local home dir", () => {
    expect(resolveFileLinkPath("~/pics/a.png", null, LOCAL, "/Users/me")).toBe(
      "/Users/me/pics/a.png",
    );
    expect(resolveFileLinkPath("~/pics/a.png", null, LOCAL, null)).toBeNull();
  });

  it("leaves ~ literal for SSH so the remote agent expands it", () => {
    expect(resolveFileLinkPath("~/pics/a.png", null, SSH, "/Users/me")).toBe(
      "~/pics/a.png",
    );
  });
});
