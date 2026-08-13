# Prompt: Debugger Phase 3 — remaining roadmap features

Read first, in this order (they are current as of 2026-07-11):
1. `debugger_handoff.md` — full system handoff for the Python debugger.
2. `debugger_mcp_spec.md` — the MCP server spec; already IMPLEMENTED (status
   header lists the implementation files). Do not rebuild it.
3. This file.

State: the debugger AND its MCP server are complete and verified (31 vitest,
6 Rust unit tests, 22 pytest, tsc/cargo clean). Branch:
`adding-new-version-0.85-features`. Your job is the four remaining roadmap
items, in this order (each independently commit-able; verify each before
moving on):

## 1. Editor UX bundle

**1a. Probe config popover.** The `Probe` model fields (`condition`,
`hitCondition`, `exprs[]`, `capture: "shape"|"stats"`, `enabled`) are wired
end-to-end (`probeToDap` in session.ts, live re-sync via
`store.updateProbe`) — there is just no editor for them. Add a right-click
(contextmenu) popover on the probe gutter in
`src/modules/debugger/lib/editorExtension.ts`.
- CRITICAL: the `extensions` array in `EditorPane.tsx` must keep static
  identity (see its comment — a changing extension wipes compartments). Do
  NOT pass props/state into the extension. Route instead through the store:
  gutter contextmenu → set a `probeEditor: {file, line, x, y} | null` slice
  on `useDebuggerStore` → a small React popover component (mount next to
  `<DebugDock/>` in App.tsx or inside it) renders from that slice and calls
  `updateProbe`/`removeProbe`.
- Fields: kind toggle (● break / ◆ trace), condition, hit condition, exprs
  (one per line), capture level, enabled, delete. Reuse the dock's styling.
- Remind the user in the popover copy: probes fire BEFORE their line.

**1b. Keyboard shortcuts.** `src/modules/shortcuts/shortcuts.ts` is the
single source of truth — add F5 (continue, or start on a .py file when
idle; DebugPill.tsx shows how it resolves script+root via
`lsp_resolve_root`), Shift+F5 (stop), F9 (toggle breakpoint on the active
editor line), Alt+F9 (toggle tracepoint), F10 (step over), F11 (step into),
Shift+F11 (step out). Gate each on session status. For F9 you need the
focused editor's file + cursor line — see how App.tsx `editorRefs` /
`goToLine` work; add a `getCursorLine()` to the editor ref surface if
nothing exposes it.

**1c. Probe line drift.** Probes are stored by line number and go stale
when the file is edited. In the debugger ViewPlugin (editorExtension.ts),
on `update.docChanged` remap each of the current file's probe lines with
`update.changes.mapPos(line-start-pos, 1)`; drop probes whose line was
deleted. Push the remapped set back with a new dedicated store action (e.g.
`remapProbes(file, moves)`) that also live-resyncs via the existing
`session.updateBreakpoints` path. Guard against feedback loops with the
store-sync ViewPlugin (compare before set). Add vitest for the pure
remapping logic (extract it as a pure function).

## 2. SSH remote debugging

Currently `DebugPill` guards to local. The plan from the handoff:
- `session.ts` hardcodes `LOCAL_WORKSPACE` — thread the active workspace
  env through instead (`useWorkspaceEnvStore`, same as the editor/LSP do).
- Tracer asset: `appCacheDir()` is local-only. For SSH, write
  `terax_debug.py` to the remote `~/.cache/terax/debug/` via the
  workspace-routed `fs_write_file` (it already routes by `workspace` arg);
  get the remote home via `ssh_home`.
- `resolvePython`: `fs_stat` is workspace-routed — pass the workspace so
  venv detection happens on the remote.
- Adapter spawn: `lsp_spawn` already implements the SSH path
  (`build_command` in `src-tauri/src/modules/lsp.rs`) — stdio-over-ssh
  should just work; pass the workspace.
- Un-guard DebugPill; `onOpenSource` paths are remote paths — the editor
  already opens workspace-routed files.
- MCP `debug_launch` should keep working locally and error clearly if asked
  to debug a remote workspace it can't resolve.
- You cannot live-test SSH here: write it, cover what's coverable with
  vitest (path/workspace routing decisions as pure functions), and leave a
  manual test checklist for the user at the end.

## 3. Tracer: sys.monitoring + torch.compile badge

In `src/modules/debugger/python/terax_debug.py`:
- On Python ≥3.12 use `sys.monitoring` (tool id
  `sys.monitoring.PROFILER_ID` — debugpy owns DEBUGGER_ID, no conflict)
  with PY_START/PY_RETURN (+ PY_UNWIND for exception exits) instead of
  `sys.setprofile`; keep `setprofile` as the <3.12 fallback. Same scope
  filter, same aggregation, same events. Watch out: monitoring callbacks
  receive code objects, not frames — the per-thread stack keying must
  change (use `threading.get_ident()` + a stack of code objects; args
  capture needs `sys._getframe` or capture-on-START via the frame from
  `inspect.currentframe().f_back`). Measure both paths in pytest
  (`test_terax_debug.py` — extend it; it must pass torch-installed and
  torch-free).
- torch.compile: compiled regions emit no profile events. Cheap fidelity
  fix per the handoff: when registering a node, check the function's
  source file once (cached) for `torch.compile` / `@torch.compile` /
  `@torch._dynamo`; if found, set `compiled_hint: true` on the node dict.
  Surface it in `GraphView.tsx` as a small badge with a tooltip ("compiled
  region — calls inside it are invisible to the tracer") and mention it in
  `query_graph` MCP output (a `compiled_hint` field).

## 4. Snapshot persistence

Graph + snapshots die with the store; agents want to query past runs.
- On `run_start`, open `appCacheDir()/debug/runs/<timestamp>-<script
  basename>.jsonl` (local FS via `fs_write_file`/append — check what
  append support exists; if none, buffer in the store and flush on
  run_end + every N events with a full rewrite, or add an
  `fs_append_file` Tauri command following fs::file patterns — async,
  never sync I/O).
- Persist the raw `TraceEvent` stream (run_start/graph/snap/crash/
  run_end) — replaying through `applyTraceEvents` reconstructs the
  GraphState exactly.
- Retention: keep the last 20 runs, delete older on launch.
- MCP: add `list_runs {}` (id, script, time, crashed?, node/snap counts)
  and a `run_id?` param on `query_graph` / `query_snapshots` /
  `find_anomalies` / `get_crash_report` that loads+folds the JSONL instead
  of the live store. Update `tool_definitions()` in
  `src-tauri/src/modules/mcp.rs` (keep descriptions LLM-oriented) and the
  dispatch table in `src/modules/debugger/lib/mcpBridge.ts`. Extend
  `mcpBridge.test.ts`.

## Verification bar (every feature)

- `npx vitest run src/modules/debugger` (extend tests with each feature)
- `<venv>/bin/python -m pytest src/modules/debugger/python/ -q` for tracer
  changes (install: `uv pip install -p <venv> pytest debugpy torch`)
- `npx tsc --noEmit`, `cargo check` in src-tauri
- `npx biome format --write` on touched files ONLY (never `biome check
  --write` — repo isn't check-clean)
- The MCP live smoke is still outstanding from phase 2: with the app
  running and Settings → General → Debugger toggled on, `claude mcp add
  …` (command shown in settings) then have Claude Code set a tracepoint
  and read find_anomalies. Do it if you get the app running; otherwise
  keep it on the user checklist.

## Gotchas carried over

- New sync Tauri commands doing I/O freeze the UI — always `async fn`
  (+ spawn_blocking if slow).
- `EditorPane.tsx` extensions array: static identity, no prop deps.
- All tracer floats must pass `_num()` (bare NaN breaks JSON.parse).
- Probes fire BEFORE their line executes (UX copy + tool notes).
- `lsp.rs` is shared infrastructure (LSP + DAP) — after touching it, test
  both a pyright session and a debug session.
- Update `.wolf/cerebrum.md`, `.wolf/memory.md`, `.wolf/buglog.json` per
  the OpenWolf protocol as you go; `.wolf/anatomy.md` is hook-maintained
  for new files.
- When done: update `debugger_handoff.md` §7 roadmap statuses and write a
  short phase-3 summary at the end of this file.

---

# Phase 3 summary (2026-07-11) — ALL FOUR FEATURES DONE

Verified: 52 vitest (`npx vitest run src/modules/debugger`), 32 pytest
torch-installed + 22 torch-free (`test_terax_debug.py`, py3.12), 6 Rust mcp
unit tests, `tsc --noEmit` + `cargo check` clean.

## 1. Editor UX bundle
- **Popover**: gutter right-click → `probeEditor` store slice →
  `components/ProbePopover.tsx` (mounted next to `<McpBridge/>` in
  App.tsx). Creates a breakpoint if the line had none. Extension identity
  untouched.
- **Shortcuts**: F5 (continue, or start on the active .py editor via the
  new shared `lib/launch.ts:startDebuggingFile`), Shift+F5, F9, Alt+F9
  (needs `getCursorLine()` — added to EditorPaneHandle), F10, F11,
  Shift+F11. New "Debugger" shortcut group; status-gated in
  `shortcutsDisabled` so inactive keys fall through.
- **Line drift**: `lib/probeRemap.ts` (pure, 7 vitest) + ViewPlugin
  `update` hook → `store.remapProbes(file, moves, dropped)` (deferred via
  queueMicrotask; sync-push guard compares refs before dispatch).

## 2. SSH remote debugging
- `LaunchConfig.workspace` (captured at `store.start`); tracer written to
  remote `~/.cache/terax/debug/` (`ssh_home` + workspace-routed fs ops);
  `resolvePython` stats the remote venv (POSIX candidates only);
  adapter spawns via `lsp_spawn`'s existing SSH path. DebugPill un-guarded
  (WSL still blocked). MCP `debug_launch` is workspace-aware and errors
  clearly on WSL; result reports the workspace. Pure routing helpers
  (`pythonCandidates`, `remoteTracerDir`, `ancestorDirs`) covered by
  `sshRouting.test.ts`.

## 3. Tracer backend + torch.compile
- `sys.monitoring` on 3.12+ (PROFILER_ID; PY_START/PY_RETURN/PY_UNWIND;
  untraced locations get DISABLE → near-zero steady-state overhead for
  library code), `sys.setprofile` fallback (<3.12 or config
  `backend:"profile"`). Both backends parametrized in pytest; `run_start`
  now carries `backend`.
- `compiled_hint` on nodes whose file mentions torch.compile/_dynamo →
  ⚡ badge in GraphView (tooltip: calls inside are invisible) + field in
  `query_graph`.
- **Bug found & fixed while validating** (bug-012 in .wolf/buglog.json):
  `_traced` cached by `id(code)`; CPython recycles freed code-object
  addresses, so user functions could silently vanish from the map (this
  also degraded phase-1/2 maps). Cache entries now pin the code object.
- `examples/debug_demo.py` added — layered call graph, recursion
  back-edge, shape-change + NaN anomalies; works with and without torch.

## 4. Run persistence
- New `fs_append_file` Tauri command (local-only, async+spawn_blocking).
- `lib/runLog.ts`: `RunLogWriter` (buffered, ordered appends, 40 MB cap)
  writes the raw TraceEvent stream to
  `appCacheDir()/debug/runs/<stamp>-<script>.jsonl`; `index.json` keeps
  summary rows (written on run end); `pruneRuns` keeps the newest 20
  (runs on every start). Wired in store.start/onTraceEvents/ended.
- MCP: `list_runs` (20th tool) + `run_id?` on query_graph /
  query_snapshots / find_anomalies / get_crash_report — loads and folds
  the JSONL through `applyTraceEvents` instead of the live store.

## Manual checklist for the user (things I couldn't live-test)

SSH remote debugging (needs a real SSH workspace):
1. Connect a window to an SSH host; open a remote `.py` file.
2. Statusbar → debug pill (or F5). Console should print
   `interpreter: … (on <host>)`; verify `~/.cache/terax/debug/terax_debug.py`
   appeared on the remote.
3. Breakpoint on a remote file line → hits, variables/REPL work, map builds.
4. Remote project with `.venv` (debugpy installed in it) → interpreter
   resolves to `<root>/.venv/bin/python`; without debugpy the console shows
   the install hint.
5. Edit the remote file while paused → probes drift with their lines.

MCP live smoke (carried over from phase 2, now with new tools):
1. Run the app, Settings → General → Debugger → enable; `claude mcp add …`
   (command shown in settings).
2. Ask Claude Code to debug `examples/debug_demo.py` with a stats
   tracepoint after `loss = compute_loss(pred)` — `find_anomalies` should
   report the first NaN around step 12 and the final shape change.
3. After the run ends: `list_runs`, then `query_graph {run_id}` on the
   previous run while a NEW run is live.
4. F5/F9/F10/F11 shortcuts + gutter right-click popover sanity pass.
