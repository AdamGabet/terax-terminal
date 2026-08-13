# Python Debugger — Full System Handoff

Everything a fresh session (or teammate) needs to understand, run, extend,
and debug Terax's Python debugger. The MCP server (not yet built) has its
own implementation spec: **`debugger_mcp_spec.md`** — read it after this.

Built 2026-07-11. All layers verified end-to-end against debugpy 1.8.21
(Python 3.12 + PyTorch 2.13): E2E driver PASS, 22 pytest, 12 vitest,
`tsc --noEmit` and `cargo check` clean.

## 1. The vision (user's words, distilled)

A **flight recorder for deep learning**, not a classic debugger:

- The centerpiece is an **execution map**, not a time-series dashboard:
  which of *my* functions ran, in what call structure, with the tensor
  shapes that flowed through them. It builds itself live as the program
  runs. The user debugs **one step / one epoch at a time**, never a whole
  training run under the debugger — so full-run tracing overhead is fine.
- Time folds *into* each node: a node hit 300× keeps a ring of recent hits
  (shapes, durations) instead of a separate timeline panel.
- Two probe types, both placed in the editor gutter:
  - **Breakpoint** (`●`, click): stop, inspect, step, REPL.
  - **Tracepoint** (`◆`, ⌥-click): never stops; snapshots variables
    (shape/dtype/device/stats) on every pass.
- **Dock layout (explicit user decision)**: bottom dock with TWO
  independently toggleable slots — left `Map ⇄ Frames`, right
  `Variables ⇄ Console`. Frames are demoted to a breadcrumb in the dock
  header (`main ▸ train_epoch ▸ train_step`); the user found a dedicated
  frames panel confusing.
- Eventually the AI drives it too — via MCP, since the user mainly uses
  Claude Code, not Terax's built-in AI (`debugger_mcp_spec.md`).

## 2. Architecture

```
┌────────────────────────── frontend (webview) ──────────────────────────┐
│ EditorPane ──debuggerEditorExtension──┐                                │
│ StatusBar ──DebugPill (entry point)───┤                                │
│ App.tsx ──<DebugDock onOpenSource>────┤                                │
│                                       ▼                                │
│                            useDebuggerStore (zustand)                  │
│                                       │ owns                           │
│                            DebugSession (session.ts)                   │
│                              │ DAP requests        ▲ events            │
│                            DapConnection (dapClient.ts)                │
└──────────────────────────────┼──────────────────────────────────────── ┘
                     invoke lsp_spawn/lsp_send/lsp_kill (Channel<Response>)
┌──────────────────────────────▼───────────────────────── rust ──────────┐
│ modules/lsp.rs — generic Content-Length framed process transport       │
│ (also serves the editor's LSP servers; DAP and LSP share the framing)  │
└──────────────────────────────┼──────────────────────────────────────── ┘
                        spawns: <python> -m debugpy.adapter   (stdio DAP)
                                       │ launch request
                        <python> terax_debug.py <script> [args]
                        (bootstrap + tracer, written to appCacheDir/debug/)
```

Two data channels come back from the debuggee:
1. **DAP protocol traffic** (responses, stopped/output/terminated events).
2. **Tracer JSONL** — `terax_debug.py` prints `@@TERAX_DBG@@{json}` lines to
   stderr; debugpy forwards them as DAP `output` events (redirectOutput);
   `OutputDemux` (traceEvents.ts) splits them from real program output,
   re-assembling lines that debugpy chunked arbitrarily.

Key fact for future work: **all session state lives in the frontend.**
Rust is a dumb pipe. (This is why the MCP server must bridge into the
webview — see the MCP spec.)

## 3. File map

Rust:
- `src-tauri/src/modules/lsp.rs` — `lsp_spawn` (framed stdio process,
  raw-bytes Channel, stderr tail, exit watcher, RSS watchdog, local + SSH
  command building), `lsp_send`, `lsp_kill`, `lsp_resolve_root` (walk-up
  marker search), `lsp_host_pid`. Registered in `lib.rs` +
  `.manage(lsp::LspState::default())`. NOTE: this repaired the editor's
  LSP feature — the upstream frontend `src/modules/lsp/` called these
  commands but the Rust side had never been integrated.

Python (shipped as an asset):
- `src/modules/debugger/python/terax_debug.py` — see §5.
- `src/modules/debugger/python/test_terax_debug.py` — pytest, torch-optional.

TypeScript `src/modules/debugger/`:
- `lib/types.ts` — `ValueDesc`, `TraceEvent`, `Probe`, DAP wire subset.
- `lib/traceEvents.ts` — `OutputDemux` + `TERAX_PREFIX`.
- `lib/graphModel.ts` — `GraphState`, `applyTraceEvents` (immutable fold),
  `layoutGraph` (longest-path layering, DFS cycle-break → `backEdge`),
  `formatValue`, `shapeSignature`, `hasNonfinite`.
- `lib/dapClient.ts` — `DapConnection`: seq/request correlation, event
  dispatch, reverse-requests declined, exit propagation.
- `lib/session.ts` — `DebugSession`: venv-aware interpreter resolve,
  tracer asset write (vite `?raw` import → `fs_write_file` to
  `appCacheDir()/debug/terax_debug.py`), DAP lifecycle, probe→DAP mapping
  (`probeToDap`: tracepoints become logpoints calling `__terax_snap`),
  mid-run breakpoint re-sync, step/eval/scopes/variables API.
- `lib/store.ts` — `useDebuggerStore`: probes per file, status, graph,
  paused {frames, selectedFrame, scopes, variables by ref}, console ring
  (2000), dock/slot UI state. Module-level `session` singleton.
- `lib/editorExtension.ts` — CM6: probe gutter + paused-line decoration +
  store-sync ViewPlugin. Wired in `EditorPane.tsx` extensions (static
  identity — do NOT make it depend on props; see comment about compartment
  wipe in EditorPane).
- `components/` — `DebugDock` (drag-resize, header controls, breadcrumb,
  slots, follow-on-pause navigation), `GraphView` (SVG map, anomaly
  borders: red = nonfinite, amber = shape change between consecutive
  hits), `VariablesView` (paused → lazy DAP tree; else selected-node
  inspector / crash report), `ConsoleView` (output + frame REPL with
  history), `FramesView`, `DebugPill` (statusbar entry), `ValueBadge`.
- `lib/graphModel.test.ts` — vitest.

Integration points touched:
- `src/app/App.tsx` — `<DebugDock onOpenSource>` mounted between the
  workspace surface and the AI input bar; opens file + `goToLine` (same
  pattern as `setLspNavigator`).
- `src/modules/editor/EditorPane.tsx` — one import + one line in the
  extensions array.
- `src/modules/statusbar/StatusBar.tsx` — `<DebugPill filePath>`.

## 4. Flows

Launch (`store.start(script, root)`):
1. `resolvePython(root)`: `<root>/.venv/bin/python` → `venv/` → win
   variants → `python3`. Printed to console as `interpreter: …`.
2. Write tracer asset; spawn `<python> -m debugpy.adapter` via `lsp_spawn`.
3. DAP: `initialize` → send `launch` (program = tracer asset, args =
   [script, ...], `console: "internalConsole"`, `redirectOutput: true`,
   `justMyCode: true`, env `TERAX_DEBUG_CONFIG` = `{root, trace, capture}`).
   **debugpy quirk**: the launch *response* only arrives after
   `configurationDone`; breakpoint config happens inside the `initialized`
   *event* handler (`sendAllBreakpoints` → `setExceptionBreakpoints
   ["uncaught"]` → `configurationDone`).
4. `stopped` event → `stackTrace` → store.paused → `selectFrameInner(0)`
   fetches scopes + first scope's variables; DebugDock's effect opens the
   source file at the paused line (deduped by frame id:line so variable
   fetches don't re-steal the cursor).
5. Probe edits while running: store actions call
   `session.updateBreakpoints(file, probes)` → one `setBreakpoints` per file.

Tracer pipeline: output event → `OutputDemux.push(category, text)` →
`TraceEvent[]` → `applyTraceEvents` folds into `graph` → GraphView
re-layouts (memo on nodes/edges refs). `snap` events append to
`graph.snapshots[probeId]` (ring 500). `crash` fills `store.crash`.

## 5. terax_debug.py internals (the load-bearing file)

- **Bootstrap**: argv[1] = real script; `runpy.run_path(run_name="__main__")`;
  script dir prepended to sys.path; installs `builtins.__terax_snap` /
  `__terax_describe`; emits `run_start`/`run_end`; on exception emits a
  `crash` report then re-raises (so debugpy still shows the stop).
- **Tracer** (`_Tracer`): `sys.setprofile` + `threading.setprofile`
  call/return hook. Scope filter (cached per code object id): realpath
  under project root, NOT this file, NOT `<...>` names, NOT
  site-packages/dist-packages (**critical**: in-project `.venv/` would
  otherwise leak debugpy internals into the map). Per-thread stacks keyed
  by frame object. Aggregates per node (count, cum time, last args/ret,
  ring of `ring`=20 recent hits) and edges (parent→child counts); flushes
  dirty deltas every `flush_ms`=250 as one `graph` event; hard cap
  `max_hits`=200k → uninstalls + `trace_budget_exhausted`.
- **describe(value, capture, depth)**: never raises, never keeps refs,
  never builds autograd graph (`torch.no_grad()`), never emits warnings
  into the user program (`warnings.catch_warnings`). Tensors: shape,
  dtype, device, `id`, `data_ptr`, `_version` (→ UI can distinguish
  rebind vs in-place vs view), requires_grad/has_grad; `capture="stats"`
  adds min/max/mean/std + `nonfinite` count in ONE fused pass (single GPU
  sync). nn.Module → param count (no root_mod gate — user subclasses live
  in their own module). **JSON safety**: all floats through `_num()` —
  Python's `json.dumps` emits bare `NaN` which JS `JSON.parse` rejects.
- **snap(probe_id, capture, **named)**: the logpoint body. `_all=locals()`
  expands all locals (dunders skipped). RETURNS the prefixed JSON line —
  the logpoint's own output event carries the payload.
- **Crash report**: walks tb, skips `<frozen runpy>`/bootstrap prelude
  (realpath of `<...>` names resolves against cwd — classic trap), captures
  own-frame locals minus modules/functions/types.

Semantics to remember (also affects UX copy): **probes fire BEFORE their
line executes** — to capture `loss`, probe the line after `loss = ...`.

## 6. Testing & verification

- Python: `uv pip install -p <venv> pytest debugpy torch` then
  `<venv>/bin/python -m pytest src/modules/debugger/python/ -q`.
  22 tests: describe edge matrix (NaN/inf JSON safety, str truncation,
  depth caps, hostile objects), snap `_all`, tracer graph/ring/
  site-packages filter, torch identity semantics (in-place bumps
  `_version` same id; rebind changes id; views share `data_ptr`), 0-dim/
  empty/bool/bfloat16 stats, grad preservation (probing a loss must not
  consume the graph — `backward()` still works after).
- Frontend: `npx vitest run src/modules/debugger` — graph fold/layout/
  recursion back-edges, demux chunk reassembly + glued-output handling.
- E2E: a Node driver replicating session.ts against real debugpy lives in
  the session scratchpad (`dap_e2e.mjs`) — recreate from §4 if needed;
  asserts: map nodes user-only, 4 tracepoint snaps incl. shrunken last
  batch, breakpoint stop, variables, `evaluate`, clean exit. Fixtures:
  `fixture_train.py` (pure python, `--crash` flag) and `fixture_torch.py`
  (rebinding + in-place + NaN injection at step 4, last batch smaller).
- `cargo check` for the Rust transport; no Rust unit tests yet
  (worthwhile addition: `read_frame` framing cases).

## 7. Known limitations / roadmap

1. **MCP server** — DONE 2026-07-11 (spec + implementation notes in
   `debugger_mcp_spec.md`): `modules/mcp.rs` serves streamable-HTTP MCP on
   127.0.0.1:<random> with a per-run bearer token (`~/.cache/terax/mcp.json`),
   bridging every tool call into the webview (`terax:mcp-request` →
   `mcpBridge.ts` dispatch → `mcp_respond`). 19 tools, SSE notifications
   (terax/stopped, terax/crash, terax/run_end). Toggle: Settings → General →
   Debugger (shows the `claude mcp add` command). Store gained `upsertProbe`/
   `removeProbe` (idempotent, agent-safe), `selectFrameAndWait`,
   `evaluateForResult`, `waitForStatus`/`waitForNextStop`.
2. **SSH remote debugging** — DONE 2026-07-11 (phase 3). `LaunchConfig`
   carries the workspace (captured from `currentWorkspaceEnv()` at start);
   the tracer asset is written to the remote `~/.cache/terax/debug/` via
   `ssh_home` + workspace-routed `fs_write_file`; `resolvePython` stats the
   remote venv; the adapter spawns through `lsp_spawn`'s SSH path. WSL
   remains guarded (lsp.rs has no WSL command path). Root resolution on
   remotes walks ancestors with workspace-routed `fs_stat`
   (`resolveRootForFile` in lib/launch.ts). NOT yet live-tested against a
   real SSH host — see the manual checklist in debugger_phase3_prompt.md.
3. **Probe config UI** — DONE 2026-07-11 (phase 3). Right-click the gutter
   → `ProbePopover` (components/ProbePopover.tsx), rendered from the
   store's `probeEditor` slice so the CM extension stays prop-free. Edits
   kind/condition/hitCondition/exprs/capture/enabled, live-resyncs.
4. **Keyboard shortcuts** — DONE 2026-07-11 (phase 3). F5 continue/start,
   Shift+F5 stop, F9/Alt+F9 toggle break/tracepoint on the cursor line
   (`getCursorLine()` on EditorPaneHandle), F10/F11/Shift+F11 steps; all in
   shortcuts.ts ("Debugger" group), gated by session status in App.tsx's
   `shortcutsDisabled` so inactive keys fall through.
5. **Probe line drift** — DONE 2026-07-11 (phase 3). `remapProbeLines`
   (lib/probeRemap.ts, pure + vitest) maps line starts through doc changes
   (whole-line deletion = span collapse check); the debugger ViewPlugin
   calls `store.remapProbes` (deferred via queueMicrotask — dispatch inside
   an update cycle throws).
6. **`torch.compile`** — DONE 2026-07-11 (phase 3). Nodes from files
   mentioning torch.compile/torch._dynamo get `compiled_hint: true`
   (cached per file), a ⚡ badge in GraphView, and a note in query_graph.
7. **Python 3.12+ `sys.monitoring`** — DONE 2026-07-11 (phase 3). Tool id
   PROFILER_ID, PY_START/PY_RETURN/PY_UNWIND, DISABLE returned for
   untraced code locations (the perf win); `sys.setprofile` remains as the
   <3.12 fallback and via config `backend: "profile"`. run_start now
   reports `backend`.
8. **Snapshots persisted** — DONE 2026-07-11 (phase 3). Every run's raw
   TraceEvent stream appends to `appCacheDir()/debug/runs/<stamp>-<script>
   .jsonl` (new local-only `fs_append_file` command; buffered writer in
   lib/runLog.ts; `index.json` summary rows; retention 20 pruned on run
   start). MCP: `list_runs` + `run_id` param on query_graph /
   query_snapshots / find_anomalies / get_crash_report (20 tools total).
9. **Known fixed bug (phase 3)**: `_Tracer._traced` cached scope decisions
   by `id(code)` — CPython recycles freed code-object addresses, so user
   functions could silently inherit a stale "untraced" verdict and vanish
   from the map. The cache now pins the code object (`(ok, code)`).

## 8. Gotchas for whoever touches this next

- `EditorPane.tsx`: the `extensions` array MUST keep static identity
  (see its comment) — the debugger extension takes `() => pathRef.current`,
  never a prop.
- `toggleProbe` toggles (same-kind click removes). Agents/idempotent
  callers need an `upsertProbe` (planned in MCP spec).
- Don't run `biome check --write` (repo isn't check-clean); use
  `biome format --write` on touched files only.
- New sync Tauri commands doing I/O freeze the UI — everything here is
  `async fn` (cerebrum Do-Not-Repeat).
- The debug console intentionally filters debugpy's `console`-category
  chatter; only error-looking lines pass through.
- If LSP servers misbehave after this change: `lsp.rs` is now shared
  infrastructure — test both consumers (a pyright session and a debug
  session) after modifying it.
