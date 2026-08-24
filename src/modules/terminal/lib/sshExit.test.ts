import { describe, expect, it } from "vitest";
import { isSshTransportFailure } from "./sshExit";

describe("isSshTransportFailure", () => {
  it("recognizes SSH transport and PTY wait failures", () => {
    expect(isSshTransportFailure(255)).toBe(true);
    expect(isSshTransportFailure(-1)).toBe(true);
  });

  it("does not treat remote application exits as transport failures", () => {
    expect(isSshTransportFailure(0)).toBe(false);
    expect(isSshTransportFailure(1)).toBe(false);
    // Windows NTSTATUS crashes are truncated by ssh to their low byte. These
    // are remote channel exits even when OpenCode's Ctrl+C triggered them.
    expect(isSshTransportFailure(5)).toBe(false);
    expect(isSshTransportFailure(9)).toBe(false);
    expect(isSshTransportFailure(130)).toBe(false);
  });
});
