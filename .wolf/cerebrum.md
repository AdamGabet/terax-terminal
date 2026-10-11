# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-05-28

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->
- For terminal split panes, prefer controls on the split divider itself (small middle button / right-click menu) rather than per-pane corner close buttons.
- Avoid overcomplicated native macOS Dock menu runtime work unless explicitly requested; prefer existing Cmd+N/New Window UI plus Dock reopen/show handling.
- User removed Cmd+N as "New Window" shortcut (felt wrong/weird as an in-app hack). New Window is now dock-menu-only.
- [2026-07-11] Debugger controls belong IN the debug dock UI, not in Settings — when offered a settings-based interpreter option, user said "in the debugger terminal not in settings". The interpreter picker lives in the DockHeader.
- [2026-10-07] User rarely uses Terax's in-app AI chat; real agents are opencode and Claude Code CLIs. For orchestration, the orchestrator should be one of THOSE agents running in a dedicated (floating/docked) Terax panel, with Terax providing visibility — don't build orchestration around the in-app AI's managed-agent tools.

## Key Learnings
- [2026-10-07] Claude Code on native Windows (winbox, v2.1.289) runs `type:command` hooks in Git Bash (`/usr/bin/bash` 5.3) by default, so POSIX hook commands work; Terax's printf-%s hook verified parsing there. winbox's SSH login shell is cmd, not PowerShell — wrap in `powershell -NoProfile -File` (scp a .ps1) rather than inline quoting.

- **macOS dock menu**: Use `objc2::ffi::class_addMethod` on the Tauri app delegate class to add `applicationDockMenu:` (returns NSMenu) and a companion action selector. The delegate is available at `NSApplication.sharedApplication.delegate` during `setup()`. objc2 0.6.x uses `unsafe extern "C-unwind" fn` signatures and `c""` literals for type encodings.
- **Project:** terax
- **Description:** <div align="center">

- **Tauri sync commands run on the main thread**: any command that can be slow (network, tree walks) must be `async fn` + `tauri::async_runtime::spawn_blocking` (the pattern git/commands.rs uses). Sync fs commands froze the whole UI once SSH made them network roundtrips.
- **SSH remoting (WorkspaceEnv::Ssh)**: system OpenSSH with ControlMaster multiplexing (`~/.cache/terax/ssh/cm-%C`, ControlPersist 600); remote scripts are base64-wrapped (`echo B64 | base64 -d | sh`) so csh/tcsh login shells can't mis-parse them; fs ops go through a python3 JSON-lines agent installed at `~/.cache/terax/remote/agent.py` (version handshake, reinstalled every connect); terminal cwd tracking polls `/proc/<pid>/cwd` via the agent (pid file written by the PTY bootstrap) because OSC 7 from SSH output is untrusted and csh shells emit none.
- **SSH streaming stdio servers (LSP/DAP) must NOT use the `… | sh` wrapper** (bug-020): `remote_script_arg`'s `echo B64 | base64 -d | sh` pipes the *script* into `sh`'s stdin, so any process the script `exec`s inherits fd0 = the base64 pipe (already EOF), NOT the SSH channel stdin. A stdio LSP/DAP server then reads instant EOF and dies (debugpy → "No more messages", exit 1). Use `remote_stream_command`/`remote_stream_script_arg` (ssh/mod.rs): decode to a random `/tmp/terax-lsp-<hex>.sh` and run `sh <file>` as a SEPARATE command so it keeps the real SSH stdin. Kept `$`-free for tcsh. `lsp.rs` build_command SSH branch uses it; capture (`exec_capture`) and PTY paths still use the plain wrapper (they don't need stdin / the PTY reconnects to the tty).
- **Terax Python-over-SSH tooling resolution**: pyright LSP root markers are `pyproject.toml/setup.py/requirements.txt/Pipfile` (NOT `.git`) — a git worktree with only `.git` resolves no root, so the LSP silently never starts and the per-root venv override (keyed by resolved root) never applies (bug-019; now surfaced via `setFailed`). The debugger differs: its `ROOT_MARKERS` include `.git` and it falls back to `dirname(path)`, and it uses the Debug-dock interpreter picker, not the LSP venv field. All three tools resolve from `<root>/.venv/bin` (or `venv/bin`) first; install with `uv pip install debugpy ruff pyright`. Skill: `.claude/skills/python-tools/`.
- **Multi-window**: capability files need a `"main-*"` glob for extra windows; `pty_close_all` must be scoped to the calling window label or a new window's boot reap kills other windows' terminals.
- **Clipboard on macOS WKWebView**: `navigator.clipboard.readText()/.read()` triggers the native "Paste" confirmation prompt on every *read*. Use the `@tauri-apps/plugin-clipboard-manager` `readText`/`writeText` (native OS access) to avoid it. The previous SSH-paste prompt came from reading the clipboard via `navigator` inside `pasteClipboard` (clipboardPaste.ts).
- **Terminal copy on macOS**: Cmd+C was never intercepted in `rendererPool.ts` (`isTerminalCopy` is gated `!IS_MAC`), so it relied on the webview's native DOM-selection copy — flaky ("works sometimes"). Added `isMacCopy` + explicit `clipboardWriteText(term.getSelection())`.
- **OS file clipboard (Finder copy)**: the clipboard-manager plugin only does text+images, not file URLs. Added a native `clipboard_read_files` command (modules/clipboard_files.rs) reading `NSPasteboard` `NSFilenamesPboardType` via raw objc2 msg_send. Windows/Linux return empty (in-app file clipboard covers them).
- **Cross-workspace file transfer**: `fs_read_file_base64` + `fs_write_file_base64` already route to SSH/local by `workspace` arg, so a base64 round-trip handles download (remote→local), upload (local→remote), and same-host copy uniformly. Capped at 50 MB (`MAX_BINARY_READ_BYTES`).
- **PTY knows its workspace**: `Session` carries `ssh_host: Option<String>` (session.rs), so SSH-only behavior can be gated at the PTY layer. The reader thread clones it (`ssh_host_for_scan`) before `Session` takes ownership. Used by the port-forward scanner: `PortScanner` (pty/port_scan.rs) scans filtered output for "listening on :PORT" lines and emits `terax:port-detected {host, port}` only for SSH sessions.
- **SSH port forwarding**: `ssh -O forward -L local:localhost:remote <host>` against the live ControlMaster (no new connection), cancel with `-O cancel`. `pick_local_port` binds 127.0.0.1:preferred then :0 for a free ephemeral fallback (ssh_forward_port returns the actual local port). `ssh_port_listening` verifies a port is really in LISTEN state via `ss`/`/proc/net/tcp`(state 0A)/`netstat` before the frontend offers to forward (kills text-match false positives). Frontend `PortForwardBridge` (src/modules/terminal) listens, verifies, toasts "Forward & Open", and cancels forwards when the window leaves the host.
- **Explorer multi-select**: `selectedPaths: Set<string>` + `leadPath` (cursor/anchor for New File/Folder + Rename) + `anchorRef` (range origin) in FileExplorer.tsx. Click modes via `onSelect(path, "only"|"toggle"|"range")` from TreeRow (plain/cmd/shift). Context-menu actions use `targets = selectedPaths.includes(path) ? selectedPaths : [path]`; right-click on a row outside the selection collapses onto it. Copy Path/Relative join with `\n`; reveal/open-in-terminal use `targets[0]`; delete shows "Delete N items" via `tree.deletePaths`.
- **Rename moved off double-click**: double-click now pin-opens a file (`onOpenFile(path, true)`); Rename is a context-menu item + F2 (handled in FileExplorer `handleKeyDown`). Single-click still opens the transient preview.
- **Transient preview tabs**: VSCode-style "open temporarily" lives in `src/modules/tabs/lib/fileTabs.ts` (pure `applyFileOpen` / `capFilePreviewTabs`), wired through `useTabs.openFileBacked`. There is ONE global preview slot shared across editor + markdown + file-preview kinds (`preview: boolean` on each); a transient open replaces whatever the slot holds. Pin via TabBar double-click (`pinTab`, now generalized to all file-backed kinds), context-menu "Open" (pin=true), or editing a code file (auto-pin in `updateTab`). Image/PDF (`file-preview`) tabs are additionally capped by the `maxFilePreviewTabs` preference (default 3, Settings → General → Explorer), evicting the oldest. `useTabs` reads the cap reactively into a ref so open callbacks stay stable.

- **In-app drag-and-drop must use pointer events, not HTML5 `draggable`**: Tauri's `dragDropEnabled` defaults to true (and we rely on it for OS file drops via `getCurrentWebview().onDragDropEvent`), which suppresses HTML5 element dragging in the WKWebView. Tab reorder (`TabBar.tsx`) and in-tree file move (`TreeRow.tsx`) both use pointerdown/move/up with a ~5px threshold + `setPointerCapture` + an `onClickCapture` guard that swallows the trailing click. Multiple `onDragDropEvent` listeners coexist (terminal vs explorer) and route by hit-testing `document.elementFromPoint` (terminal acts only over `[data-pane-leaf]`, explorer only over `[data-fs-path]`/`[data-explorer-root]`).
- **Recursive cross-workspace copy**: `copyPathsIntoFolder` (contextActions.ts) is the single workhorse behind Paste AND drag-drop. Files round-trip via base64 (`fs_read_file_base64`→`fs_write_file_base64`); folders recurse via `fs_stat`+`fs_read_dir`(showHidden:true)+`fs_create_dir` (ignores "already exists" to merge). Works local→local and local→SSH. In-tree moves use `tree.movePaths` → `fs_rename` (atomic, files+dirs, refuses overwrite, guards self/descendant drops).
- **Pinch-zoom**: `usePinchZoom(ref, setZoom, {min,max})` (file-preview/usePinchZoom.ts) handles both macOS trackpad signals — `wheel`+ctrlKey and WebKit `gesturestart/change` (incremental `scale/lastScale` factor, no need to read live zoom). Reused by image pane + PDF viewer. To get both-axis scroll when zoomed, size content by real dimensions (image wrapper `width/height: ${zoom*100}%` inside `overflow-auto`; PDF column wrapped in `flex min-w-full justify-center`) — a CSS `transform: scale()` does NOT grow scrollWidth/Height so scrollbars never appear.
- **Biome**: the repo is NOT `biome check`-clean (untouched files fail organizeImports/format); CI doesn't enforce it. The project's actual convention is `biome format` (the `format` script = `biome format --write ./src`). Run `biome format --write <files>` on touched files; don't run `biome check --write` (it would re-sort all imports and churn unrelated lines).

## Key Learnings (2026-07-11 phase 3 additions)
- **Never key a cache on `id(obj)` of a GC-able Python object without pinning it**: `_Tracer._traced` cached scope verdicts by `id(code)`; CPython recycles freed code-object addresses (runpy compiles the user script AFTER bootstrap frames were cached), so user functions silently inherited stale "untraced" verdicts. Fix: store `(verdict, code)` so the object stays alive (bug-012).
- **sys.monitoring (py3.12+)**: use `PROFILER_ID` (debugpy owns DEBUGGER_ID); callbacks get code objects, not frames — grab args via `sys._getframe(1)` at PY_START; returning `sys.monitoring.DISABLE` for untraced code locations is the perf win; PY_UNWIND (exceptional) canNOT be DISABLEd; call `restart_events()` on install because DISABLE persists per-location across installs in one interpreter.
- **CM6: never dispatch from inside a ViewPlugin `update()`** — store mutations that re-enter a store-subscribed `view.dispatch` must be deferred (queueMicrotask). The debugger probe-drift remap does this; the sync push also compares refs before dispatching to avoid loops.
- **CM6 whole-line-deletion detection**: `MapMode.TrackDel` misses deletions starting exactly at the line start; the robust check is span collapse — `changes.mapPos(lineStart, -1) === changes.mapPos(nextLineStart, 1)` (probeRemap.ts).
- **fs_append_file exists now** (fs/file.rs): local-only append (creates parents), added for debugger run logs. Everything else stays workspace-routed.
- **Debugger runs persist** to `appCacheDir()/debug/runs/*.jsonl` + `index.json` (RunLogWriter in runLog.ts); replaying through `applyTraceEvents` reconstructs GraphState exactly. MCP is at 20 tools — the Rust test `tool_definitions_are_well_formed` asserts the count, bump it when adding tools.
- **lsp_resolve_root is local-only**; remote root resolution walks ancestors with workspace-routed fs_stat (`resolveRootForFile` in debugger/lib/launch.ts).

## Do-Not-Repeat
- [2026-10-07] Never put a JSON hook payload in printf's format string — zsh/bash≥4 expand `\uXXXX` to raw control bytes (invalid JSON). Use `printf %s '<json>'`. macOS /bin/bash 3.2 hides this; test with zsh.

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->
- [2026-06-11] Dock "New Window" spawned a new app instance (`open -n`) → separate dock icon. Create an in-process WebviewWindow (label main-N) via a stored AppHandle instead.
- [2026-06-11] New sync Tauri commands doing remote I/O froze the UI ("file opens stuck"). Always async + spawn_blocking.
- [2026-07-16] Don't spawn a streaming stdio server (LSP/DAP) over SSH with the `echo B64|base64 -d|sh` wrapper — it hands the server the base64 pipe as stdin (instant EOF → "debug adapter exited (code 1)"/pyright never talks). Use `remote_stream_command` (temp-file + `sh <file>`). Diagnose adapter exits with `DEBUGPY_LOG_DIR=<dir>` on the remote, read `debugpy.adapter-*.log`. Also: genie65's login shell is tcsh — remote debug commands can't use `$`, `$(...)`, or `2>/dev/null`; wrap in `sh -c '…'` when you need Bourne syntax.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
- 2026-06-04: Did not add a custom AppKit `New Window` Dock menu item because Tauri lacks a simple API and the native delegate/runtime approach is too invasive for the requested scope.
- 2026-06-04: Implemented macOS dock "New Window" via `class_addMethod` on the Tauri app delegate class (`applicationDockMenu:` + `teraxNewWindow:` action). Uses `objc2 0.6` (already a transitive dep - zero extra binary size). Removed the Cmd+N in-app shortcut at user request.
- [2026-06-12] tauri.conf.json CSP has `object-src 'none'` — `<embed>`/`<object>` never render anything (this silently killed the PDF preview). Render in-app instead (pdf.js for PDFs).
- [2026-06-12] Clipboard image → remote Claude Code: no protocol exists (OSC 52 is text-only; Claude Code declined kitty OSC 5522, issue #42712). The ecosystem-standard fix is upload-to-remote-temp-file + paste absolute path; Claude Code auto-attaches images from pasted absolute paths.
- [2026-06-12] When adding an SSH agent op, bump AGENT_VERSION in BOTH src-tauri/src/modules/ssh/agent.py and agent.rs (version handshake kills the connection otherwise).

## Decision Log — tmux Tabs (2026-06-23)
- User chose **Option B** over Option A for the tmux feature: normal tabs stay plain shells; only explicitly-created "tmux tabs" persist. Rationale: avoids forcing a tmux server on every terminal, and matches the "+ dropdown adds a tmux-tab option" UX. Closing a tmux tab detaches (not kills); killing is done via a list popover. No process reparenting (not portable). SSH targets remote tmux over the existing ControlMaster connection. Spec: tmux_spec.md.

- **2026-07-10 — Python debugger direction**: User vision = "flight recorder" debugger for deep learning: two probe types — classic DAP breakpoints AND non-stopping tracepoints (debugpy logpoints with injected `__terax_snap` helper emitting JSON via output events) that capture tensor shape/dtype/device/stats into a timeline graph panel. Snapshots stored structured (JSONL/SQLite) so Terax agents can query them and place probes themselves. Reuse existing SSH port forwarding for remote debugpy attach. Capture levels: shape-only (default) / stats / sample, due to GPU sync cost.

## Decision Log — Python Debugger (2026-07-11)
- **Vision**: "flight recorder" for deep learning — the graph panel is an EXECUTION MAP (which functions ran, with tensor shapes flowing through), not a time-series dashboard; time folds into each node's recent-hits history. User debugs one step/epoch at a time, so full-run tracing overhead is acceptable.
- **Dock layout (user decision)**: bottom dock, TWO independently toggleable slots — left Map⇄Frames, right Variables⇄Console. Frames demoted to a header breadcrumb (user found frames confusing). Entry point = statusbar DebugPill on .py files.
- **Architecture**: DAP shares LSP's Content-Length framing → one Rust framed-process transport (modules/lsp.rs, commands lsp_spawn/send/kill/resolve_root/host_pid) serves both codemirror-languageserver AND the debugger (python -m debugpy.adapter). The upstream frontend lsp module was calling these commands with no Rust side — implementing them fixed editor LSP too.
- **Tracer**: bootstrap (terax_debug.py, shipped via vite ?raw import, written to appCacheDir/debug) runs user script under runpy with sys.setprofile call/return hook scoped to project root (minus site-packages). Tracepoints = debugpy logpoints whose logMessage calls builtins.__terax_snap; events stream as @@TERAX_DBG@@ JSONL on stderr through DAP output events.
- **debugpy quirks learned**: launch response arrives only after configurationDone (config happens inside the `initialized` event); logpoints evaluate BEFORE the line runs (probe the line after an assignment); breakpoints in the launched script work under runpy; interpreter must have debugpy importable — session resolves <root>/.venv python first.
- **JSON safety**: Python json.dumps emits bare NaN (invalid for JS JSON.parse) — all tracer numbers pass through _num() which stringifies non-finite floats.

## Decision Log — Debugger MCP Server (2026-07-11)
- **Architecture**: debug session state lives in the webview, so the MCP server (src-tauri/src/modules/mcp.rs) is a bridge, not an owner: streamable-HTTP JSON-RPC on 127.0.0.1:<random port> → `emit_to(label, "terax:mcp-request", {id,tool,args})` → frontend dispatch table (mcpBridge.ts) → `invoke("mcp_respond", {id,ok,payload})` → oneshot-style mpsc back to the HTTP thread (30s timeout). Only the "main"-labeled window hosts the bridge (McpBridge.tsx registers via `mcp_register`, which also clears orphaned pending calls on webview reload).
- **No rmcp crate**: hand-rolled HTTP on std::net::TcpListener + thread-per-connection (same style as lsp.rs) — MCP streamable HTTP is just POST of JSON-RPC + optional GET SSE stream; avoided an axum dependency. Only new dep: getrandom (bearer token). Auth: per-app-run 32-byte hex token, discovery file ~/.cache/terax/mcp.json (0600), `claude mcp add --transport http ... --header "Authorization: Bearer <token>"`.
- **Agent-safe probe API**: `upsertProbe`/`removeProbe` added to the debugger store because `toggleProbe`'s same-kind-click-removes semantics would delete a breakpoint when an agent calls set_breakpoint twice.
- **Step settling**: after continue/step, tools wait on `waitForNextStop()` (store transition to a NEW paused object, or ended) — the DAP `stopped` event can arrive before the step response, so the store, never the DAP response, is the source of truth for "where did we land".
- **Server lifecycle follows a preference**: `debuggerMcpEnabled` (Settings → General → Debugger, default OFF); settings window renders the add-command via idempotent `mcp_start`; the main window's McpBridge starts/stops the listener when the pref syncs over `terax://prefs-changed`.

## Key Learnings (2026-07-11 additions)
- **Recovering deleted uncommitted files**: every file the AI wrote survives in the Claude Code session transcripts at `~/.claude/projects/<project-slug>/*.jsonl` — find the Write tool_use entry (`message.content[].input.content`) and re-extract it. Used to restore debugger_mcp_spec.md verbatim after accidental deletion.
- **anatomy.md is hook-maintained**: new files get indexed automatically after Write — no manual anatomy updates needed for file creation.
- **find_anomalies caveat baked into tool notes**: NaN/Inf in tensors is only detectable at tracepoint capture:"stats" (shape level doesn't compute nonfinite counts) — every relevant MCP tool result says so, or agents will read "no anomalies" as "no NaNs".

## Key Learnings (appended 2026-07-11)
- LSP editor keybindings (go-to-def F12, rename F2, format Shift-Alt-F, Cmd/Ctrl+click) live in `src/modules/lsp/lib/client.ts` `lspInteractions`, a CodeMirror keymap — SEPARATE from the global `SHORTCUTS` registry / `useGlobalShortcuts`. To make them rebindable they now read `usePreferencesStore.getState().shortcuts` and reconfigure a `Compartment` on store change.
- Pyright will NOT start unless the folder contains a root marker: pyproject.toml / setup.py / requirements.txt / Pipfile. Python's `rootMarkers` deliberately does NOT fall back to `.git` (see sessionManager.ts:74). A `.git`+`.venv`-only folder gets no server and silently no LSP features.
- `shell_run_command` (external formatters like prettier/ruff) runs `/bin/sh -c` on unix (shell/mod.rs:343), NOT a login shell despite the doc comment — it inherits the app process PATH. LSP servers (`lsp_spawn`) also use process PATH via `Command::new`.
- Formatter routing (`externalFormat.ts` `resolveFormatter`): a global external formatter only applies to langs its tool lists; anything else (e.g. .py under Prettier) falls back to "lsp". Prettier and pyright both cannot format Python — use Ruff (`ruff format`) via a language override.

## Key Learnings (appended 2026-07-12)
- LSP binary resolution is now venv-aware. `lsp_detect(command, root?, venv?)` in `lsp.rs` → `resolve_command`: explicit path → manual `venv` override → repo `.venv`/`venv` (`bin/` + Windows `Scripts/`) → PATH. `sessionManager.acquireDocExtension` resolves the ROOT first, then calls `resolveServerBinary` (detect.ts) and spawns the returned ABSOLUTE path — so pyright/ruff installed only inside a project venv are both detected and launched from there, not PATH.
- `detectBinary(command)` (PATH-only, cached in runtimeStore.detected keyed by bare command) is kept for the Settings global status line + `useLspHint` install/enable distinction. The venv-aware `resolveServerBinary(command, root, venv)` has its OWN cache (composite key, negatives not cached) and is what feeds spawning.
- Per-repo venv override: `lspVenvOverrides: Record<rootPath, venvDir>` in preferences (store.ts, setter `setLspVenvOverride`). A subscribe in sessionManager restarts sessions for a changed root via `closeSession` (which bumps generation → open docs re-acquire).
- Cross-window "current repo": the main window mirrors `explorerRoot` to Rust via `set_active_root` (App.tsx effect); the settings window reads it with `get_active_root` + the `terax:active-root` event (`ActiveRoot(Mutex)` state in lib.rs). Use this pattern whenever the separate settings window needs main-window workspace context.
- `useLspHint` is now venv-aware too: it resolves the file's root (`lsp_resolve_root`) + venv override and calls `resolveServerBinary`, holding the result in LOCAL state (not runtimeStore.detected) — so the enable/install pill reflects a venv-only install. `runtimeStore.detected` (PATH-only, via `detectBinary`) is still what the Settings server list shows.
- The Codex `*.integration.test.ts` suites (codexEndpoint, codexToolFlow, codexAutocomplete) hit LIVE endpoints and fail without network/auth — 15 failures there are expected in a sandbox and are NOT a regression. All other vitest unit tests must pass.

## Do-Not-Repeat (2026-07-12)
- The Write/Edit tools can store a literal space that sits INSIDE a string literal (e.g. `const SEP = " "`) as a raw NUL byte (0x00). The Read tool then renders that NUL as a space, so subsequent Edits typed with a space won't match (byte mismatch) and fail with "String to replace not found". Diagnose with `sed -n 'Np' file | od -c` (look for `\0`). Fix by using an explicit escape like `" "`, or `perl -i -pe 's/\x00/\\u0000/g'`. Never leave a raw NUL in source.

## Key Learnings (appended 2026-07-25)

- `HebrewRtlTransform` (src/modules/terminal/lib/hebrewRtl.ts) sits between the PTY
  and xterm.js in `deliverPtyBytes` (useTerminalSession.ts). xterm.js has no bidi,
  so Hebrew runs are reversed in the byte stream before they are written.
- Reordering already-painted cells requires erasing and repainting the row, which
  is only sound when the row is a pure append of printable characters. Any TUI
  (Claude Code, vim, tmux) paints with cursor moves — CUF `\x1b[nC`, CHA `\x1b[nG`
  — and those skipped columns never reach the row model. Repainting there
  swallows the gaps. The transform now tracks `lineModelValid` / `altScreen` /
  `cols` and falls back to in-place per-segment reordering whenever the row model
  cannot be trusted.
- `repaint()` diffs the new visual order against the `painted` baseline and emits
  only the appended delta when earlier cells did not move. A full repaint writes
  the whole row under the current SGR state, so it destroys per-run colouring —
  avoid it whenever an append suffices.
- The `src/modules/ai/lib/codex*.integration.test.ts` suites hit a live endpoint
  and fail with 401 without credentials. They are not a signal when checking a
  local change; run the targeted vitest file instead.

## Key Learnings (appended 2026-09-17)
- xterm.js defaults `macOptionIsMeta` to **false**, so on macOS the Option key composes characters (⌥s → `ß`) instead of sending a Meta/ESC prefix. Every `alt+…` keybinding in a hosted TUI (pi, vim, emacs, tmux) is silently dead until it is set. It lives in `termOptions()` in `src/modules/terminal/lib/rendererPool.ts`; iTerm2 and Terminal.app expose the same thing as an opt-in setting. Trade-off: enabling it removes Option-character input (ß, ø, å, €) in the terminal.

## Key Learnings (appended 2026-10-07 — agent orchestration research)
- Claude Code 2.1.29x ships native fleet primitives: `claude agents --json [--all]` (lists interactive + --bg sessions: pid, cwd, sessionId, name, status/state, waitingFor), `claude --bg --name X`, `claude attach|logs|stop <id>`, and `ListAgents`/`SendMessage` cross-session messaging (same machine only; mac/Linux ≥2.1.224, native Windows ≥2.1.234 via named pipes; WSL↔Windows can't talk). Build Terax views ON these, not parallel buses.
- Unattended workers need `crossSessionInbound: "accept"` or messages from a non-bypass sender are held and expire (5 min under -p).
- Hook `terminalSequence` (our OSC 777 status) is ignored in `claude -p` → headless workers never show via OSC detector.
- MCP channels need `--dangerously-load-development-channels` (dialog, ignored under -p) — not usable for unattended delivery.
- opencode v2 API is all `/api/*` (v1's `/session/status`, `prompt_async`, `/tui/*`, `opencode attach` are GONE). Shared service discovered via `~/.local/state/opencode/service.json`; `GET /api/session`, `/api/session/active`, SSE `/api/event`, `POST /api/session/{id}/prompt`; attach = `opencode -s <id>`. Don't trust docs at opencode.ai/docs (v1) — use opencode.ai/v2/docs. No peer messaging in opencode.
- Windows gaps in Terax agent detection: profile.ps1 emits no OSC 133;C (no preexec); `build_windows` SSH has no shell integration; Windows remotes get no Claude hooks (installer is POSIX heredoc); `match_agent` rejects `claude.exe`; POSIX hook command fails if Claude falls back to PowerShell (no Git Bash) — use exec-form hooks or `"shell":"powershell"`.
- Win32-OpenSSH kills session processes on disconnect (job object) → Start-Process workers die; tmux unsupported on Windows remotes.
- Python `os.kill(pid, 0)` on Windows TERMINATES the process — never use it as a liveness check.

## Decision Log — Agent orchestration (2026-10-07)
- Rejected plan v1 (file bus + Python MCP server + channels + Stop-hook delivery + spawn_agent tool) after adversarial review: duplicates native Claude features, spawn tool = RCE primitive, Stop-hook reason = prompt-injection amplifier, genie65 $HOME is NFS/97% full. v2 = Fleet board over `claude agents --json` per host + orchestrator agent in a pane on the workers' host. See STATUS.md.

## Do-Not-Repeat (2026-10-07 — tmux)
- [2026-10-07] Always run tmux with the client flag `-u` when parsing `-F` output. Without a UTF-8 locale (app launched from Finder/Dock, `env -i`) tmux rewrites tabs and non-ASCII in format output to `_`. Reproduce with `env -i PATH=/usr/bin:/bin tmux ls -F $'#{session_name}\t#{session_path}'`.
- tmux session nicknames are stored as the session user option `@terax_nick` (set via `tmux_set_nickname`), so they live on the tmux server and also work over SSH.

## Key Learnings (appended 2026-10-07 — fleet board build)
- `claude agents --json --all` (2.1.292) lists headless `claude -p` sessions too (kind "interactive", auto-named `<cwd-basename>-<hex>`), so existing nohup loops are visible without migration; only `--bg` sessions (`kind: "background"`, `state: running|blocked`, `waitingFor`) can be `claude attach`ed. Two terminals can attach to the same `--bg` session at once (verified); killing the attach clients leaves the session running. `claude --bg` refuses untrusted dirs ("Workspace not trusted").
- Claude transcript path: `~/.claude/projects/<slug>/<sessionId>.jsonl`, slug = cwd with every non-alphanumeric char → `-` (`construction_ohad` → `construction-ohad`). One API response = several `assistant` lines sharing `message.id` → dedupe usage by id. `gitBranch`/`cwd` on every entry; subagent turns `isSidechain:true`; `isMeta` user lines are injected context.
- Fleet module layout: `src-tauri/src/modules/fleet.rs` (`fleet_list/fleet_stop/fleet_transcript_tail`, routed by WorkspaceEnv like tmux.rs; Windows/WSL → Err), `src/modules/fleet/` (store polls 5s only while a view is visible, ×2 backoff to 60s; `OrchestratorWindow` = clone of FloatingTerminalWindow with reserved leafId 1; `FleetBoard` = `"fleet"` tab kind, one per workspace scope). Orchestrator = `claude --bg --name orchestrator` + `claude attach orchestrator` typed via `TerminalPane restartCommand` (decided from a fresh listing, not `a || (b && c)` — fish/tcsh).
- `restartCommand` is only typed after an OSC `133;S` shell marker; shells without Terax integration (tcsh on genie65) never emit one. `useTerminalSession` now has a 1.5 s fallback (only when `restartShell` is unset) — the tty queues the keystrokes until the shell reads them.
- ⌘I / `ai.toggle` and the status-bar button now open the orchestrator window; the in-app AI panel code is untouched (still reachable via attach-file / ask-selection paths and ⇧⌘I mini window).

## Do-Not-Repeat (2026-10-07 — fleet)
- [2026-10-07] `rustfmt src-tauri/src/lib.rs` follows `mod` declarations and reformats EVERY submodule (lsp.rs, pty/mod.rs churned). Run rustfmt only on the files you touched, never on lib.rs/mod.rs, and check `git status` afterwards.
- [2026-10-07] react-resizable-panels v4 in this repo: `ResizablePanelGroup orientation="horizontal"` (not `direction`), `defaultSize="26%"` strings (not numbers), panels need `id`.
- [2026-10-07] The 14 Codex `*.integration.test.ts` failures in `vitest run` are live-endpoint tests (network/auth) and fail on a clean tree — not a regression signal.

## Key Learnings (appended 2026-10-07 — fleet resume)
- `claude --bg --resume <full sessionId> --name <n>` (run from the session's cwd) works together: on a removed/stopped session it continues under the SAME id (`backgrounded · aad4bda3 · probe-fmt (idle — send a prompt to start)` on stdout, nothing on stderr). If the session is still listed (even state `done`), it starts a COPY with a new id and prints `note: session aad4bda3 is already running in the background, so this started a copy as 3137454b…` — so `claude rm <id>` a finished session before resuming it if you want the same id. `claude rm` works on exited sessions, `claude stop` only on live ones.
- [2026-10-07] Claude Code transcripts are NOT always at ~/.claude/projects/<slug(cwd)>/<sid>.jsonl — worktree sessions (cwd `.claude/worktrees/<n>`) are filed under the launch dir's slug. Fleet falls back to globbing projects/*/<sid>.jsonl.
- [2026-10-07] User preference: no click-to-copy on text (session ids). Show plain text + a small copy icon that appears only after selecting the row.
- [2026-10-07] Attach-in-split (fleet) layout: user wants 2x2 grid — left|right, then right top/bottom, then left top/bottom (gridSplitTarget in panes.ts). Max 4 panes/tab.
- [2026-10-07] `claude agents --all` keeps stopped bg sessions listed (state "stopped", no pid). Filter them when looking for a live session (findOrchestrator).
- [2026-10-07] After `claude stop`, `claude agents --all` may report the bg session as state "done" (not "stopped") with NO pid. Liveness = background && pid != null (isLiveAgent). Verify CLI states empirically, don't trust a single sample.
- [2026-10-08] opencode v2 accepts caller-chosen session ids if they start with `ses_` (`ses_agent-x`): `opencode run --auto -s ses_<name> --title <name> "msg"` creates then continues it, blocks until the turn ends, prints the reply, exits non-zero on failure. Default model in a bare dir may be unusable → pass `-m provider/model`. `opencode session list` is project(cwd)-scoped; `/api/session` lists all projects.
- [2026-10-08] User wants the orchestrator to stay Claude; opencode is a *worker* type the Claude orchestrator spawns/messages (not an orchestrator option).
- [2026-10-08] opencode v2 API: OpenAPI spec at `GET /openapi.json` on the service (not /api/*). Messages `GET /api/session/{id}/message?limit&order=desc` (types user{text}/assistant{content[text|reasoning|tool], model, tokens}/idle{outcome}); tool item `state{status,input,content[],error{type,message}}`. Pending: `GET /api/session/{id}/permission` ({action,resources}) and `/form` ({title}); `/api/permission/request` is scoped by `location` (defaults to $HOME) so it's not a global list. Messages are big (~10 KB each with tool output).
- [2026-10-08] Full `vitest run` has 14 pre-existing failures in `*codex*.integration.test.ts` (hit the live Codex endpoint) — unrelated noise.
