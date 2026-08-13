import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { dispatchTool, type ToolArgs } from "../lib/mcpBridge";
import { useDebuggerStore } from "../lib/store";

type McpRequest = { id: number; tool: string; args: ToolArgs };

/** Headless bridge between the Rust MCP server and the debugger store.
 * Only the main window hosts it — the debug session lives there. */
export function McpBridge() {
  const isMain = getCurrentWindow().label === "main";
  const enabled = usePreferencesStore((s) => s.debuggerMcpEnabled);
  const hydrated = usePreferencesStore((s) => s.hydrated);

  // Request dispatch: terax:mcp-request → tool handler → mcp_respond.
  useEffect(() => {
    if (!isMain) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void invoke("mcp_register").catch(() => {});
    void listen<McpRequest>("terax:mcp-request", ({ payload }) => {
      const { id, tool, args } = payload;
      void (async () => {
        try {
          const result = await dispatchTool(tool, args ?? {});
          await invoke("mcp_respond", {
            id,
            ok: true,
            payload: result ?? { ok: true },
          });
        } catch (e) {
          await invoke("mcp_respond", {
            id,
            ok: false,
            payload: (e as Error).message ?? String(e),
          }).catch(() => {});
        }
      })();
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isMain]);

  // Server lifecycle follows the preference (also across app restarts).
  useEffect(() => {
    if (!isMain || !hydrated) return;
    void invoke(enabled ? "mcp_start" : "mcp_stop").catch(() => {});
  }, [isMain, hydrated, enabled]);

  // Store transitions → MCP notifications (SSE): stopped / crash / run_end.
  useEffect(() => {
    if (!isMain) return;
    let prev = useDebuggerStore.getState();
    return useDebuggerStore.subscribe((st) => {
      const before = prev;
      prev = st;
      if (st.status === "paused" && st.paused && st.paused !== before.paused) {
        const f = st.paused.frames[0];
        void invoke("mcp_notify", {
          event: "terax/stopped",
          payload: {
            reason: st.paused.reason,
            file: f?.source?.path ?? null,
            line: f?.line ?? null,
            function: f?.name ?? null,
          },
        }).catch(() => {});
      }
      if (st.crash && st.crash !== before.crash) {
        void invoke("mcp_notify", {
          event: "terax/crash",
          payload: { exc_type: st.crash.excType, exc_msg: st.crash.excMsg },
        }).catch(() => {});
      }
      if (st.status === "ended" && before.status !== "ended") {
        void invoke("mcp_notify", {
          event: "terax/run_end",
          payload: { detail: st.statusDetail },
        }).catch(() => {});
      }
    });
  }, [isMain]);

  return null;
}
