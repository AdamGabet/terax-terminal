# Debugger MCP Server — Handoff Spec

Goal: expose Terax's Python debugger as an MCP server so any MCP client
(primarily Claude Code) can drive it — place probes, run scripts, read the
execution map and snapshots, step, evaluate — while the human watches the
same session live in the Terax GUI.

Status: IMPLEMENTED 2026-07-11 (including SSE notifications, v1.5). Kept as
the design reference. Implementation: `src-tauri/src/modules/mcp.rs` (server,
hand-rolled HTTP on std::net — no rmcp; 6 Rust unit tests),
`src/modules/debugger/lib/mcpBridge.ts` (dispatch table, 19 tools, vitest),
`src/modules/debugger/components/McpBridge.tsx` (headless bridge, main window
only), settings toggle in Settings → General → Debugger.

## What already exists (read these first)

| Piece | File | Notes |
|---|---|---|
| DAP session | `src/modules/debugger/lib/session.ts` | `DebugSession`: launch/stop/step/evaluate/scopes/variables/updateBreakpoints |
| Store (single source of truth) | `src/modules/debugger/lib/store.ts` | `useDebuggerStore`: probes, status, graph, paused frames/vars, console; actions mirror everything the GUI can do |
| Graph model | `src/modules/debugger/lib/graphModel.ts` | `GraphState` = nodes/edges/snapshots; pure fold + layout |
| Tracer events | `src/modules/debugger/lib/traceEvents.ts` | `@@TERAX_DBG@@` JSONL demux |
| Python tracer | `src/modules/debugger/python/terax_debug.py` | emits run_start/graph/snap/crash/run_end |
| Rust framed transport | `src-tauri/src/modules/lsp.rs` | spawns debugpy adapter; NOT needed for MCP directly |

Key architectural fact: **the debug session and all its state live in the
frontend (webview TS), not in Rust.** The MCP server must therefore live in
Rust (it needs an HTTP listener) and *bridge* every tool call into the
webview. Do not try to re-home the session in Rust.

## Architecture (recommended)

```
Claude Code ──HTTP (streamable)──► Rust MCP server (new: modules/mcp.rs)
                                        │ tauri Emitter: "terax:mcp-request" {id, tool, args}
                                        ▼
                              Frontend McpBridge (new: src/modules/debugger/lib/mcpBridge.ts)
                                        │ executes against useDebuggerStore / DebugSession
                                        ▼
                              invoke("mcp_respond", {id, result|error})
                                        │
                              Rust matches id → HTTP response to client
```

- Transport: MCP **streamable HTTP** on `127.0.0.1:<random port>`.
  Claude Code connects with `claude mcp add --transport http terax-debug http://127.0.0.1:<port>/mcp`.
- Crate: `rmcp` (official Rust MCP SDK, has axum-based streamable-http
  server). If its axum dependency is unwanted, a raw JSON-RPC-over-HTTP
  loop with `tiny_http` is acceptable — MCP streamable HTTP is POST of
  JSON-RPC messages + optional SSE stream for notifications.
- Discovery + auth: on server start write `~/.cache/terax/mcp.json`
  `{ "port": N, "token": "<32 random bytes hex>" }` (0600). Require
  `Authorization: Bearer <token>`. Regenerate per app run. Also print the
  ready-made `claude mcp add` command to the debug console / a settings UI.
- Multi-window: route bridge events to the window whose label is `main`
  (or the first window that registered the bridge — keep a registered-window
  label in the Rust state; the bridge registers via `invoke("mcp_register")`
  on mount and unregisters on unload).

## Bridge protocol (Rust ⇄ frontend)

Rust state: `pending: Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>`.

1. Tool call arrives → `id = next_id()`, insert oneshot, `app.emit_to(label, "terax:mcp-request", {id, tool, args})`.
2. Frontend `McpBridge` (a headless component mounted in `App.tsx`, same
   pattern as `PortForwardBridge`) has a `listen("terax:mcp-request")`
   handler: dispatch on `tool`, run it, then `invoke("mcp_respond", { id, ok, payload })`.
3. Rust resolves the oneshot; 30 s timeout → MCP error `"terax window did not respond"`.
4. Notifications go the other way: frontend calls `invoke("mcp_notify", {event, payload})`
   → Rust forwards as MCP notification on the SSE stream (see Notifications).

## Tool surface (v1)

All results must be **LLM-sized**: truncate aggressively, never dump the raw
store. Reuse `formatValue`/`shapeSignature` from `graphModel.ts` for compact
tensor strings.

Session:
- `debug_launch { script, root?, args?, trace?=true }` → `{ok, interpreter}`.
  Guard: error if a session is live. Root default: `lsp_resolve_root` with
  `["pyproject.toml","requirements.txt","setup.py",".git"]` else dirname.
  Implementation: `useDebuggerStore.getState().start(script, root)`.
- `debug_stop {}` / `debug_status {}` → `{status, statusDetail, script, pausedAt?}`.

Probes (work before AND during a run — store handles live re-sync):
- `set_breakpoint { file, line, condition?, hit_condition? }`
- `set_tracepoint { file, line, exprs?: string[], capture?: "shape"|"stats", hit_condition? }`
  → `toggleProbe`+`updateProbe` (or add a dedicated `upsertProbe` store action —
  cleaner; toggle semantics are wrong for idempotent agents).
- `remove_probe { file, line }` / `list_probes {}`.

Execution (require status === "paused" except pause):
- `debug_continue` / `step_over` / `step_into` / `step_out` / `debug_pause`.
  After each step the tool should WAIT for the next `stopped`/`running`
  settle (subscribe to store until status changes, 10 s cap) and return the
  new location `{file, line, function}` so the agent gets stateful feedback
  in one round-trip.

Inspection:
- `get_stack {}` → frames `[{i, function, file, line}]` (cap 40).
- `get_variables { frame?: number }` → selected frame's locals, one line per
  var (`name`, `type`, `value` truncated to ~120 chars). Use
  `selectFrame(i)` then read `paused.variables`; needs a store helper that
  awaits the fetch (`selectFrameAndWait`).
- `evaluate { expression, frame? }` → `{result}`. Warn in the tool
  description that expressions run with side effects in the debuggee.

Recorded data (works while running AND after the run ends — big win):
- `query_graph {}` → nodes `[{name, file, line, count, total_ms, last_args
  (shape strings), last_ret}]` + edges `[{from, to, count}]`. Cap 200 nodes,
  note truncation.
- `query_snapshots { probe_id?, last?: number }` → snapshot rows with shape
  strings; flag rows where `nonfinite > 0` or shape differs from previous row
  (reuse `shapeSignature`).
- `find_anomalies {}` → scan `graph.snapshots` + node `recent` rings for
  first NaN/Inf occurrence and shape changes; return `[{where, hit_n, what}]`.
  This is the tool the agent reaches for first — make it good.
- `get_crash_report {}` → `crash` from store, locals as shape strings.

## Notifications (v1.5, optional but high-value)

MCP notifications over the streamable-HTTP SSE channel:
- `terax/stopped {reason, file, line, function}` — breakpoint/exception hit
- `terax/crash {exc_type, exc_msg}`
- `terax/run_end {exit_code}`

Frontend side: subscribe once in McpBridge to store transitions
(`status`→paused, `crash` set, status→ended) and `invoke("mcp_notify", ...)`.
If SSE plumbing is annoying, defer — agents can poll `debug_status`.

## Implementation order

1. `src-tauri/src/modules/mcp.rs`: HTTP listener + token + `mcp.json`,
   `mcp_register`/`mcp_respond`/`mcp_notify` Tauri commands, bridge map.
   Register in `modules/mod.rs` + `lib.rs` (+ `.manage(McpState::default())`).
2. MCP handshake: `initialize` (serverInfo `terax-debugger`), `tools/list`
   (static JSON schemas), `tools/call` → bridge. `rmcp` does 90% of this.
3. `src/modules/debugger/lib/mcpBridge.ts` + `McpBridge` headless component
   mounted next to `<DebugDock/>` in `App.tsx`. Pure dispatch table
   `Record<string, (args) => Promise<unknown>>` — unit-testable without MCP.
4. Store additions: `upsertProbe`, `removeProbe`, `selectFrameAndWait`,
   `waitForStatusSettle` (promise that resolves on next paused/running/ended).
5. Settings toggle (Settings → General): "Enable debugger MCP server"
   default OFF; when ON, start listener + show the `claude mcp add` line.
6. Tests: vitest on the dispatch table with a mocked store; Rust unit test
   for the HTTP handshake; live smoke: `claude mcp add` + ask Claude Code to
   set a tracepoint on the torch fixture and report the NaN step
   (fixtures exist in the scratchpad flow — recreate under `src/modules/debugger/python/` if needed).

## Pitfalls

- **Payload discipline**: `graph.nodes[*].recent` and `snapshots` grow big;
  never serialize `ValueDesc` trees raw — flatten to strings.
- **Toggle vs upsert**: `toggleProbe` removes an existing same-kind probe —
  agents calling `set_breakpoint` twice would delete it. Add `upsertProbe`.
- **Window lifecycle**: if the webview reloads mid-call the oneshot leaks —
  the 30 s timeout covers it; clear `pending` on `mcp_register`.
- **Security**: never bind non-loopback; bearer token mandatory; the token
  file is the only discovery mechanism (no fixed port).
- **Two debuggers**: MCP `debug_launch` while the human debugs → return a
  clear error (`"session already active — stop it in Terax first"`).
- **Step race**: `stopped` may arrive before the `next` response; use the
  store-settle helper, not the DAP response, as the source of truth.

## Done criteria

Claude Code (via `claude mcp add`) can, on the torch fixture: launch with a
tracepoint, read `find_anomalies` → "NaN first at train_step hit 5", set a
conditional breakpoint `not torch.isfinite(loss)`, re-run, land paused on
the right line, `evaluate` in the frame, and the human sees all of it live
in the dock.
