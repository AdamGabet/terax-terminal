import { Button } from "@/components/ui/button";
import { useTheme } from "@/modules/theme";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import type { SearchAddon } from "@xterm/addon-search";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { reconnectSsh, useTerminalSession } from "./lib/useTerminalSession";

export type TerminalPaneHandle = {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
};

type Props = {
  /** Stable identifier for this leaf (passed back through callbacks). */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** This leaf is the active pane within its tab — receives auto-focus. */
  focused?: boolean;
  initialCwd?: string;
  onSearchReady?: (leafId: number, addon: SearchAddon) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
};

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(
  function TerminalPane(
    {
      leafId,
      visible,
      focused = true,
      initialCwd,
      onSearchReady,
      onExit,
      onCwd,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { resolvedMode, themeId, customThemes } = useTheme();

    const session = useTerminalSession({
      leafId,
      container: containerRef,
      visible,
      focused,
      initialCwd,
      onSearchReady: (a) => onSearchReady?.(leafId, a),
      onExit: (c) => onExit?.(leafId, c),
      onCwd: (c) => onCwd?.(leafId, c),
    });

    useEffect(() => {
      // Defer one frame so CSS-variable token resolution sees the new class.
      const id = requestAnimationFrame(() => session.applyTheme());
      return () => cancelAnimationFrame(id);
    }, [resolvedMode, themeId, customThemes, session]);

    useImperativeHandle(
      ref,
      () => ({
        write: (data: string) => session.write(data),
        focus: () => session.focus(),
        getBuffer: (max?: number) => session.getBuffer(max),
        getSelection: () => session.getSelection(),
      }),
      [session],
    );

    // Window-level SSH liveness — the whole window binds to one host, so a drop
    // affects every terminal pane. The overlay only renders on the visible pane.
    const sshHost = useWorkspaceEnvStore((s) =>
      s.env.kind === "ssh" ? s.env.host : null,
    );
    const sshStatus = useWorkspaceEnvStore((s) => s.sshStatus);
    const reconnectAttempts = useWorkspaceEnvStore((s) => s.reconnectAttempts);
    const nextAttemptAt = useWorkspaceEnvStore((s) => s.nextAttemptAt);
    const showReconnect =
      visible && sshHost !== null && sshStatus !== "connected";
    const reconnecting = sshStatus === "reconnecting";

    // Tick once a second while disconnected so the "attempting in" countdown
    // stays live.
    const [nowTs, setNowTs] = useState(() => Date.now());
    useEffect(() => {
      if (!showReconnect) return;
      setNowTs(Date.now());
      const id = setInterval(() => setNowTs(Date.now()), 1000);
      return () => clearInterval(id);
    }, [showReconnect]);

    const attemptsLabel =
      reconnectAttempts > 0
        ? `${reconnectAttempts} attempt${reconnectAttempts === 1 ? "" : "s"}`
        : "";
    let detail: string;
    if (reconnecting) {
      detail = reconnectAttempts > 0 ? `attempt ${reconnectAttempts}…` : "…";
    } else if (nextAttemptAt) {
      const secs = Math.max(0, Math.ceil((nextAttemptAt - nowTs) / 1000));
      detail = attemptsLabel
        ? `${attemptsLabel} · attempting in ${secs}s`
        : `attempting in ${secs}s`;
    } else {
      // Auto-retries stopped — manual only. No countdown.
      detail = attemptsLabel ? `stopped · ${attemptsLabel}` : "";
    }

    return (
      <div className="relative h-full w-full">
        <div
          ref={containerRef}
          className="zoom-exempt h-full w-full"
          style={{
            visibility: visible ? "visible" : "hidden",
            pointerEvents: visible ? "auto" : "none",
          }}
        />
        {showReconnect && (
          // z-50 so the card sits above xterm's canvas layers; the wrapper is
          // click-through and only the card itself captures the pointer (so the
          // cursor/click lands on Reconnect, not the terminal underneath).
          <div className="pointer-events-none absolute bottom-3 left-3 z-50">
            <div className="pointer-events-auto flex items-center gap-3 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
              <div className="flex flex-col gap-0.5">
                <span className="text-foreground">
                  {reconnecting ? "Reconnecting to " : "Connection to "}
                  <span className="font-medium">{sshHost}</span>
                  {reconnecting ? "…" : " lost"}
                </span>
                {detail ? (
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {detail}
                  </span>
                ) : null}
              </div>
              <Button
                size="sm"
                disabled={reconnecting}
                onClick={() => void reconnectSsh()}
              >
                {reconnecting ? "Reconnecting…" : "Reconnect"}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  },
);
