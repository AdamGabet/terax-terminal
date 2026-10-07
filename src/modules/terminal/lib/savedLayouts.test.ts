import { describe, expect, it } from "vitest";
import {
  allowedExecutable,
  lastShellMarker,
  nestedShellFor,
  normalizeRestartAllowlist,
  parseSavedLayoutsState,
  restoredLaunchStep,
} from "./savedLayouts";

describe("saved layout command allowlist", () => {
  it("stores only a normalized executable name", () => {
    const allowlist = normalizeRestartAllowlist([
      " Claude ",
      "bash",
      "claude",
      "bad command",
    ]);

    expect(allowlist).toEqual(["claude", "bash"]);
    expect(
      allowedExecutable("/usr/local/bin/claude --resume secret", allowlist),
    ).toBe("claude");
    expect(allowedExecutable("rm -rf /", allowlist)).toBeNull();
  });

  it("recognizes a shell started from the prompt as a shell", () => {
    expect(nestedShellFor("bash")).toBe("bash");
    expect(nestedShellFor("exec /bin/zsh -l")).toBe("zsh");
    expect(nestedShellFor("claude --resume")).toBeNull();
    expect(nestedShellFor(null)).toBeNull();
  });

  it("rechecks persisted commands at parse boundaries", () => {
    const state = parseSavedLayoutsState(
      JSON.stringify({
        restartAllowlist: ["bash", "bad command"],
        layouts: [
          {
            id: "layout-1",
            name: "Remote agents",
            createdAt: 1,
            workspace: { kind: "ssh", host: "devbox" },
            activeTabIndex: 0,
            tabs: [
              {
                title: "agent",
                activeLeafIndex: 0,
                paneTree: {
                  kind: "leaf",
                  cwd: "/srv/app",
                  restartShell: "bash",
                  restartCommand: "claude; shutdown",
                },
              },
            ],
          },
        ],
      }),
    );

    expect(state.restartAllowlist).toEqual(["bash"]);
    expect(state.layouts[0].tabs[0].paneTree).toEqual({
      kind: "leaf",
      cwd: "/srv/app",
      restartShell: "bash",
    });
  });
});

describe("restored shell launch", () => {
  it("enters the saved shell before starting the saved command", () => {
    // A shell typed at the prompt is not integrated, so it never emits a second
    // shell marker: both writes must go out together or the command is stranded.
    expect(restoredLaunchStep("zsh", "bash", "claude")).toEqual({
      write: "bash\rclaude\r",
      complete: true,
    });
    expect(restoredLaunchStep("zsh", "bash")).toEqual({
      write: "bash\r",
      complete: true,
    });
    expect(restoredLaunchStep("bash", "bash", "claude")).toEqual({
      write: "claude\r",
      complete: true,
    });
    expect(restoredLaunchStep("zsh", undefined, "claude")).toEqual({
      write: "claude\r",
      complete: true,
    });
  });

  it("waits until shell integration is ready", () => {
    expect(restoredLaunchStep(null, "bash", "claude")).toEqual({
      write: null,
      complete: false,
    });
  });

  it("recognizes shell markers split across PTY chunks", () => {
    const first = "banner\x1b]133;S;ba";
    const second = "sh\x1b\\prompt";

    expect(lastShellMarker(first)).toBeNull();
    expect(lastShellMarker(first.slice(-64) + second)).toBe("bash");
  });
});
