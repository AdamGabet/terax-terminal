import { describe, expect, it } from "vitest";
import { resolveCandidates } from "../NewEditorDialog";

const ROOT = "/repo/proj";
const HOME = "/Users/me";

describe("resolveCandidates", () => {
  it("returns nothing for blank input", () => {
    expect(resolveCandidates("", ROOT, HOME)).toEqual([]);
    expect(resolveCandidates("   ", ROOT, HOME)).toEqual([]);
  });

  it("takes an absolute path as the only candidate", () => {
    expect(resolveCandidates("/etc/hosts", ROOT, HOME)).toEqual(["/etc/hosts"]);
  });

  it("expands ~ against home", () => {
    expect(resolveCandidates("~", ROOT, HOME)).toEqual([HOME]);
    expect(resolveCandidates("~/a/b.png", ROOT, HOME)).toEqual([
      "/Users/me/a/b.png",
    ]);
  });

  it("tries the workspace root before home for a relative path", () => {
    expect(resolveCandidates("notes.md", ROOT, HOME)).toEqual([
      "/repo/proj/notes.md",
      "/Users/me/notes.md",
    ]);
    expect(resolveCandidates("Downloads/x.pdf", ROOT, HOME)).toEqual([
      "/repo/proj/Downloads/x.pdf",
      "/Users/me/Downloads/x.pdf",
    ]);
  });

  it("trims surrounding whitespace", () => {
    expect(resolveCandidates("  a.ts  ", ROOT, HOME)).toEqual([
      "/repo/proj/a.ts",
      "/Users/me/a.ts",
    ]);
  });

  it("does not duplicate when root and home are the same", () => {
    expect(resolveCandidates("a.ts", HOME, HOME)).toEqual(["/Users/me/a.ts"]);
  });

  it("degrades to whichever base is known", () => {
    expect(resolveCandidates("a.ts", null, HOME)).toEqual(["/Users/me/a.ts"]);
    expect(resolveCandidates("a.ts", ROOT, null)).toEqual(["/repo/proj/a.ts"]);
    expect(resolveCandidates("a.ts", null, null)).toEqual([]);
    expect(resolveCandidates("~/a.ts", ROOT, null)).toEqual([]);
  });

  it("joins without doubling a trailing slash", () => {
    expect(resolveCandidates("a.ts", "/repo/proj/", null)).toEqual([
      "/repo/proj/a.ts",
    ]);
  });
});
