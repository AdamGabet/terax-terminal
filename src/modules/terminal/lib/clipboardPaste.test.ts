import { describe, expect, it } from "vitest";
import {
  isLargePaste,
  remotePastePaths,
} from "./clipboardPaste";

describe("remotePastePaths", () => {
  it("keeps POSIX upload and pasted paths identical", () => {
    expect(
      remotePastePaths("/home/adam/", "posix", "paste-1.png"),
    ).toEqual({
      uploadPath: "/home/adam/.cache/terax/remote/paste-1.png",
      pastePath: "/home/adam/.cache/terax/remote/paste-1.png",
    });
  });

  it("pastes a native Windows path while uploading through the normalized path", () => {
    expect(
      remotePastePaths("C:/Users/adam", "windows", "paste-1.png"),
    ).toEqual({
      uploadPath: "C:/Users/adam/.cache/terax/remote/paste-1.png",
      pastePath: "C:\\Users\\adam\\.cache\\terax\\remote\\paste-1.png",
    });
  });
});

describe("Windows SSH large paste", () => {
  it("uses Claude's documented large-paste thresholds", () => {
    expect(isLargePaste("a".repeat(800))).toBe(false);
    expect(isLargePaste("a".repeat(801))).toBe(true);
    expect(isLargePaste("one\ntwo")).toBe(false);
    expect(isLargePaste("one\ntwo\nthree")).toBe(true);
  });
});
