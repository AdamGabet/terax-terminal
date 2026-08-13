# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-30T10:43:32.290Z
> Files: 459 tracked | Anatomy hits: 0 | Misses: 0

## ../../../../../private/tmp/claude-501/-Users-adamgabet-Documents-coding-terax-terminal/0897596e-17d9-446d-9524-c13f28c7b75b/scratchpad/

- `probe.sh` (~147 tok)
- `probe2.sh` (~246 tok)
- `probe3.sh` (~256 tok)

## ../../../../../private/tmp/claude-501/-Users-adamgabet-Documents-coding-terax-terminal/36b72b39-ad71-4ea4-b125-f9c5d384211a/scratchpad/

- `dap_e2e.mjs` — End-to-end DAP flow against real debugpy, replicating Terax's session.ts: (~1679 tok)
- `fixture_torch.py` — Mini training loop with real tensors: rebinding, in-place, NaN injection. (~298 tok)
- `fixture_train.py` — Tiny training-loop-shaped fixture (no torch needed). (~237 tok)

## ../../../../../private/tmp/claude-501/-Users-adamgabet-Documents-coding-terax-terminal/54342d99-5f6e-4d52-a00a-ce558928af0d/scratchpad/

- `dap_drive.py` — Drive the remote debugpy adapter over the exact Terax ssh spawn. (~660 tok)
- `dap_fix.py` — Test the FIXED wrapper: deliver script via temp file so adapter keeps ssh stdin. (~699 tok)

## ../../../.claude/plans/

- `2-more-really-cool-shiny-whistle.md` — Explorer multi-select, double-click open, and SSH port-forward detection (~2887 tok)
- `change-tabs-order-with-woolly-yeti.md` — Terax — Tab & File-Explorer UX features (~2534 tok)
- `reconnect-session-of-ssh-pure-duckling.md` — SSH Session Reconnect (manual button, keep history + open files) (~2000 tok)

## ../../../.claude/projects/-Users-adamgabet-Documents-coding-terax-terminal/memory/

- `agent-fleet-worktree-setup.md` (~403 tok)
- `genie65-compute-box.md` (~395 tok)
- `winbox-agent-machine.md` (~332 tok)

## ../stocks/

- `pyproject.toml` — Minimal project marker so editors/tools recognize this folder as the (~67 tok)

## ./

- `.gitignore` — Git ignore rules (~72 tok)
- `AGENTS.md` (~2 tok)
- `CLAUDE.md` — OpenWolf (~59 tok)
- `CODE_OF_CONDUCT.md` — Code of conduct (~413 tok)
- `components.json` (~170 tok)
- `CONTRIBUTING.md` — Contributing to Terax (~2761 tok)
- `debugger_handoff.md` — Python Debugger — Full System Handoff (~3922 tok)
- `debugger_mcp_spec.md` — Debugger MCP Server — Handoff Spec (~2419 tok)
- `debugger_phase3_prompt.md` — Prompt: Debugger Phase 3 — remaining roadmap features (~3080 tok)
- `index.html` — Terax (~250 tok)
- `LICENSE` — Project license (~3023 tok)
- `package.json` — Node.js package manifest (~1032 tok)
- `pnpm-lock.yaml` — pnpm lock file (~98605 tok)
- `pnpm-workspace.yaml` (~12 tok)
- `README.md` — Project documentation (~1491 tok)
- `ROADMAP.md` — Roadmap (~1786 tok)
- `SECURITY.md` — Security (~513 tok)
- `settings.html` — Terax — Settings (~248 tok)
- `TERAX.md` — TERAX.md (~4679 tok)
- `tmux_spec.md` — tmux Tabs — Feature Spec (~1702 tok)
- `tsconfig.json` — TypeScript configuration (~187 tok)
- `tsconfig.node.json` (~61 tok)
- `vite.config.ts` — Vite build configuration (~785 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## .claude/skills/python-tools/

- `SKILL.md` — Python tooling for Terax (uv) (~1724 tok)
- `SKILL.md` — Python tooling for Terax (uv) (~1214 tok)
- `verify.sh` — Verify Terax's Python tooling (debugpy, ruff, pyright) is installed in a (~578 tok)
- `verify.sh` — Verify Terax's Python tooling (debugpy, ruff, pyright) is installed in a (~399 tok)

## .github/

- `CODEOWNERS` (~3 tok)
- `PULL_REQUEST_TEMPLATE.md` — What (~232 tok)

## .github/ISSUE_TEMPLATE/

- `bug_report.yml` (~622 tok)
- `config.yml` (~131 tok)
- `feature_request.yml` (~465 tok)

## .github/workflows/

- `ci.yml` — CI: CI (~555 tok)
- `release.yml` — CI: Release (~837 tok)

## examples/

- `debug_demo.py` — Demo for Terax's execution map — run this under the debugger (F5). (~892 tok)

## src-tauri/

- `.gitignore` — Git ignore rules (~45 tok)
- `build.rs` (~12 tok)
- `Cargo.toml` — Rust package manifest (~622 tok)
- `Info.plist` (~79 tok)
- `installer-hooks.nsh` (~445 tok)
- `tauri.conf.json` (~742 tok)
- `tauri.linux.conf.json` (~55 tok)
- `tauri.windows.conf.json` (~77 tok)

## src-tauri/capabilities/

- `default.json` (~297 tok)
- `desktop.json` (~82 tok)

## src-tauri/gen/schemas/

- `acl-manifests.json` — Declares command (~25388 tok)
- `capabilities.json` (~253 tok)
- `desktop-schema.json` (~46308 tok)
- `macOS-schema.json` (~46308 tok)

## src-tauri/icons/

- `icon.icns` (~226488 tok)

## src-tauri/icons/android/mipmap-anydpi-v26/

- `ic_launcher.xml` (~75 tok)

## src-tauri/icons/android/values/

- `ic_launcher_background.xml` (~33 tok)

## src-tauri/src/

- `lib.rs` — Set during setup so native callbacks (macOS dock menu) and on-demand SSH (~4398 tok)
- `main.rs` — Prevents additional console window on Windows in release, DO NOT REMOVE!! (~52 tok)

## src-tauri/src/modules/

- `agent.rs` — agent_enable_claude_hooks, agent_claude_hooks_status (~2211 tok)
- `clipboard_files.rs` — Reading file paths off the OS clipboard. (~769 tok)
- `codex.rs` — [derive(Debug, Deserialize, Serialize)] (~2420 tok)
- `lsp.rs` — Framed-process transport for LSP and DAP servers. (~4570 tok)
- `mcp.rs` — MCP server exposing the Python debugger to MCP clients (Claude Code). (~7110 tok)
- `mod.rs` (~60 tok)
- `net.rs` — HttpResponse: lm_ping, ai_http_request, ai_http_stream (~5079 tok)
- `proc.rs` — [cfg(windows)] (~86 tok)
- `secrets.rs` — Secret storage with platform-appropriate backends. (~1875 tok)
- `workspace.rs` — Short TTL keeps the auth-check TOCTOU window tight while still coalescing the (~6901 tok)

## src-tauri/src/modules/fs/

- `file.rs` — FileStat: fs_read_file, fs_read_file_base64, fs_write_file_base64, fs_write_file (~3543 tok)
- `grep.rs` — GrepHit: fs_grep, fs_glob (~2403 tok)
- `mod.rs` — The single canonical-to-display conversion: forward slashes, Windows (~488 tok)
- `mutate.rs` — Creates a new empty file. Fails if the file already exists. (~2134 tok)
- `search.rs` — Absolute path of the matched file. (~2094 tok)
- `tree.rs` — Milliseconds since UNIX epoch; 0 if unavailable. (~1285 tok)
- `watch.rs` — Quiet-gap before a batch flushes; MAX_WINDOW caps latency under a long stream. (~2446 tok)

## src-tauri/src/modules/git/

- `commands.rs` — git_resolve_repo, git_panel_snapshot, git_status, git_diff + 13 more (~2146 tok)
- `errors.rs` — [derive(Debug)] (~970 tok)
- `mod.rs` (~27 tok)
- `operations.rs` — resolve_repo, panel_snapshot, status, diff, diff_content (~9221 tok)
- `parser.rs` — [derive(Default)] (~2977 tok)
- `process.rs` — ensure_git_available, git_show_text, git_stdout_line_opt, git_stdout_lines, read_text_file (~4467 tok)
- `types.rs` — Struct: GitRepoInfo (~935 tok)
- `utils.rs` — [derive(Clone, Debug)] (~1360 tok)

## src-tauri/src/modules/pty/

- `agent_detect.rs` — AgentSignal: into_signal, new, with_agents, process + 1 more (~3580 tok)
- `da_filter.rs` — DaFilter: new, process (~2023 tok)
- `job.rs` — Windows Job Object with KILL_ON_JOB_CLOSE for ConPTY children. (~682 tok)
- `mod.rs` — PtyState: pty_open, pty_write, pty_resize, pty_close (~3023 tok)
- `port_scan.rs` — Scans terminal output for "a server is now listening on :PORT" lines so the (~2034 tok)
- `session.rs` — Session: spawn (~3986 tok)
- `shell_init.rs` — [derive(Clone, Debug, Deserialize)] (~8893 tok)

## src-tauri/src/modules/pty/scripts/

- `bashrc.bash` — terax-shell-integration (bashrc) (~569 tok)
- `init.fish` — terax-shell-integration (fish) (~367 tok)
- `profile.ps1` — terax-shell-integration (PowerShell) (~536 tok)
- `zlogin.zsh` — terax-shell-integration (zlogin) (~153 tok)
- `zprofile.zsh` — terax-shell-integration (zprofile) (~72 tok)
- `zshenv.zsh` — terax-shell-integration (zshenv) (~116 tok)
- `zshrc.zsh` — terax-shell-integration (zshrc) (~523 tok)

## src-tauri/src/modules/shell/

- `background.rs` — BackgroundProc: read_logs, kill, info, spawn (~1480 tok)
- `mod.rs` — CommandOutput: shell_run_command, shell_session_open, shell_session_run, shell_session_close (~3651 tok)
- `ringbuffer.rs` — Byte-oriented bounded ring buffer with monotonic offsets. (~1150 tok)
- `session.rs` — ShellSession: new, current_cwd, run (~1850 tok)

## src-tauri/src/modules/ssh/

- `agent.py` — Terax remote agent. (~5570 tok)
- `agent.rs` — Must match AGENT_VERSION in agent.py. (~2155 tok)
- `fsops.rs` — Remote filesystem operations: each mirrors a local `fs::*` command and (~2359 tok)
- `mod.rs` — SshRegistry: registry, connection, agent, validate_host (~8588 tok)

## src/

- `main.tsx` — showWindow (~412 tok)
- `vite-env.d.ts` — / <reference types="vite/client" /> (~11 tok)

## src/app/

- `App.tsx` — waitForClaudeTuiReady (~20076 tok)

## src/components/

- `WindowControls.tsx` — Render only the close button (used by the settings window). (~706 tok)

## src/components/ai-elements/

- `chat-code-lezer.ts` — Exports HighlightedNode, isHighlightable, highlight (~2853 tok)
- `chat-code.tsx` — StreamingCtx — uses useContext, useRef, useEffect, useState (~2278 tok)
- `context.tsx` — PERCENT_MAX — uses useContext, useMemo (~2825 tok)
- `conversation.tsx` — Conversation — uses useCallback (~1312 tok)
- `markdown-code.tsx` — Streamdown `components.code` override. Handles both inline (`code`) and (~232 tok)
- `message.tsx` — Message (~2545 tok)
- `reasoning.tsx` — ReasoningContext (~1755 tok)
- `shimmer.tsx` — motionComponentCache — uses useMemo (~606 tok)
- `snippet.tsx` — SnippetContext (~953 tok)
- `tool.tsx` — TOOL_META (~6942 tok)

## src/components/ui/

- `alert-dialog.tsx` — AlertDialog (~1603 tok)
- `alert.tsx` — alertVariants (~586 tok)
- `badge.tsx` — badgeVariants (~533 tok)
- `breadcrumb.tsx` — Breadcrumb (~754 tok)
- `button-group.tsx` — buttonGroupVariants (~801 tok)
- `button.tsx` — buttonVariants (~841 tok)
- `card.tsx` — Card (~731 tok)
- `checkbox.tsx` — Checkbox (~560 tok)
- `collapsible.tsx` — Collapsible (~224 tok)
- `command.tsx` — Command — renders modal (~1435 tok)
- `context-menu.tsx` — ContextMenu (~2445 tok)
- `dialog.tsx` — Dialog — renders modal (~1234 tok)
- `dropdown-menu.tsx` — DropdownMenu (~2592 tok)
- `empty.tsx` — Empty (~686 tok)
- `hover-card.tsx` — HoverCard (~437 tok)
- `input-group.tsx` — InputGroup (~1461 tok)
- `input.tsx` — Input (~268 tok)
- `item.tsx` — ItemGroup (~1364 tok)
- `kbd.tsx` — Kbd (~252 tok)
- `label.tsx` — Label (~170 tok)
- `menubar.tsx` — Menubar (~2477 tok)
- `popover.tsx` — Popover (~687 tok)
- `progress.tsx` — Progress (~212 tok)
- `radio-group.tsx` — RadioGroup (~464 tok)
- `resizable.tsx` — ResizablePanelGroup/Panel/Handle wrappers; handle can render custom children. (~474 tok)
- `scroll-area.tsx` — ScrollArea (~480 tok)
- `select.tsx` — Select (~1963 tok)
- `separator.tsx` — Separator (~180 tok)
- `sheet.tsx` — Sheet (~1333 tok)
- `skeleton.tsx` — Skeleton (~79 tok)
- `slider.tsx` — Slider — uses useMemo (~547 tok)
- `sonner.tsx` — Toaster (~169 tok)
- `spinner.tsx` — Spinner (~135 tok)
- `switch.tsx` — Switch (~467 tok)
- `tabs.tsx` — Tabs (~1020 tok)
- `textarea.tsx` — Textarea (~235 tok)
- `toggle-group.tsx` — ToggleGroupContext — uses useContext (~931 tok)
- `toggle.tsx` — toggleVariants (~482 tok)
- `tooltip.tsx` — TooltipProvider (~562 tok)

## src/lib/

- `fonts.ts` — Exports ensureMonoFontsLoaded, detectMonoFontFamily (~434 tok)
- `launchDir.ts` — Exports initLaunchDir, getLaunchDir (~121 tok)
- `platform.ts` — Custom window controls (min/max/close) are rendered by us only on (~308 tok)
- `shellQuote.test.ts` — Declares q (~388 tok)
- `shellQuote.ts` — Exports quoteShellArg (~67 tok)
- `use-mobile.ts` — Exports useIsMobile (~162 tok)
- `useZoom.ts` — Exports useZoom (~443 tok)
- `utils.ts` — Exports cn (~48 tok)

## src/modules/agents/

- `index.ts` (~43 tok)

## src/modules/agents/components/

- `AgentNotificationsBridge.tsx` — tabInfo — uses useEffect (~963 tok)
- `AgentToast.tsx` — showAgentToast (~126 tok)
- `NotificationBell.tsx` — relativeTime — renders form (~3857 tok)

## src/modules/agents/lib/

- `agentIcon.tsx` — iconFor (~267 tok)
- `notify.ts` — Exports osNotify (~212 tok)
- `review.ts` — Exports maybeTriggerManagedReview, firePendingReviewForSession (~549 tok)
- `route.ts` — True when the user is currently looking at this agent. (~342 tok)
- `types.ts` — Exports AgentStatus, AgentSource, AgentSignalKind, AgentSignal + 4 more (~235 tok)
- `useWindowFocus.ts` — Exports useWindowFocus (~183 tok)

## src/modules/agents/store/

- `agentStore.ts` — Exports useAgentStore (~729 tok)
- `managedAgentsStore.ts` — Exports DEFAULT_MAX_ROUNDS, ManagedPhase, ManagedAgent, useManagedAgentsStore (~807 tok)

## src/modules/ai/

- `config.ts` — Provider accepts (but does not require) an API key. (~9153 tok)
- `index.ts` — Declares ProviderKeys (~170 tok)

## src/modules/ai/agents/

- `registry.ts` — Whitelist of tools the subagent may call. Excludes mutating tools and (~773 tok)
- `runSubagent.ts` — Exports runSubagent, DEFAULT_SUBAGENT_MODEL (~571 tok)

## src/modules/ai/components/

- `AgentRunBridge.tsx` — Headless bridge that mirrors chat lifecycle, approval IDs, and diff tabs into store state. (~3516 tok)
- `AgentStatusPill.tsx` — AgentStatusPill (~562 tok)
- `AgentSwitcher.tsx` — ICONS (~1705 tok)
- `AiChat.tsx` — CommandSnippet — uses useCallback, useMemo (~6064 tok)
- `AiInputBar.tsx` — detectSnippetTrigger — uses useState, useEffect (~4832 tok)
- `AiMiniWindow.tsx` — SUGGESTIONS — uses useEffect, useMemo (~5414 tok)
- `AiStatusBarControls.tsx` — PROVIDER_ICON — uses useState, useMemo (~5718 tok)
- `AiToolApproval.tsx` — TOOL_META (~1754 tok)
- `FilePicker.tsx` — FilePickerContent — uses useEffect (~1058 tok)
- `lazy.tsx` — AgentRunBridgeInner (~444 tok)
- `LocalAgentNotificationsBridge.tsx` — AGENT — uses useRef, useEffect (~658 tok)
- `PlanDiffReview.tsx` — basename — uses useState (~2289 tok)
- `SelectionAskAi.tsx` — W — uses useEffect (~466 tok)
- `SnippetPicker.tsx` — SnippetPickerContent (~1429 tok)
- `TodoStrip.tsx` — EMPTY_TODOS — uses useEffect (~926 tok)

## src/modules/ai/hooks/

- `useWhisperRecording.ts` — Exports useWhisperRecording (~932 tok)
- `useWorkspaceFiles.ts` — Exports WorkspaceFilesState, useWorkspaceFiles (~738 tok)

## src/modules/ai/lib/

- `agent.ts` — Exports BuildModelOptions, buildLanguageModel, LocalProviderConfig, buildConfiguredLanguageModel (~5701 tok)
- `agents.ts` — Exports AgentIconId, Agent, BUILTIN_AGENTS, LoadedAgents + 5 more (~1365 tok)
- `codexBody.test.ts` — Tests for patchCodexBody — the body-mutation layer applied to every Codex (~2788 tok)
- `codexBody.ts` — Pure helpers for patching the JSON request body that @ai-sdk/openai builds (~1297 tok)
- `codexEndpoint.integration.test.ts` — Integration tests — real HTTP requests to chatgpt.com/backend-api/codex/responses (~3322 tok)
- `compact.ts` — Exports CompactResult, compactModelMessages, compactModelMessagesDetailed (~1622 tok)
- `composer.tsx` — Composer provider; builds message parts and denies pending approvals before sending new user input. (~3524 tok)
- `keyring.ts` — Exports ProviderKeys, EMPTY_PROVIDER_KEYS, getKey, setKey + 3 more (~688 tok)
- `miniWindowGeometry.test.ts` — Declares Geom (~891 tok)
- `miniWindowGeometry.ts` — Exports Geom, Viewport, ResizeDir, MIN_W + 5 more (~582 tok)
- `modelPrefs.ts` — Exports toggleFavoriteModel, pushRecentModel (~233 tok)
- `native.ts` — Exports ReadResult, DirEntry, CommandOutput, GrepHit + 15 more (~2651 tok)
- `placeholders.ts` — Exports pickPlaceholder (~146 tok)
- `proxyFetch.ts` — Streaming events emitted by the Rust `ai_http_stream` command. (~1338 tok)
- `reasoning.ts` — Exports REASONING_LEVELS, ReasoningLevel, DEFAULT_CHAT_REASONING_LEVEL, DEFAULT_AUTOCOMPLETE_REASONING_LEVEL + 3 more (~468 tok)
- `redact.ts` — Exports redactSensitive (~376 tok)
- `security.test.ts` — Declares identity (~2463 tok)
- `security.ts` — Path-safety guards for AI tool calls. (~4296 tok)
- `sessions.ts` — Exports SessionMeta, LoadedSessions, loadAll, loadMessages + 6 more (~729 tok)
- `slashCommands.ts` — Outcome of intercepting a slash command from the composer. (~1100 tok)
- `snippets.ts` — The "#handle" used in the composer. Lowercase, [a-z0-9-]+. (~623 tok)
- `todos.ts` — Validate a candidate todo list: (~419 tok)
- `transport.ts` — Exports createContextAwareTransport, CONTEXT_BLOCK_RE, stripContextBlock (~1882 tok)
- `useMiniWindowGeometry.ts` — Drives the mini window's position and size entirely through the DOM (no (~1437 tok)

## src/modules/ai/store/

- `agentsStore.ts` — All agents, builtin first. (~578 tok)
- `chatStore.ts` — Chat/session store; tracks approval responders and pending approval IDs for safe message sends. (~5167 tok)
- `planStore.ts` — Tool that produced the queued mutation. (~604 tok)
- `snippetsStore.ts` — Exports useSnippetsStore (~373 tok)
- `todoStore.ts` — Map of sessionId -> todos. (~456 tok)

## src/modules/ai/tools/

- `agent.ts` — Claude Code's TUI treats a trailing CR in the same write chunk as the text (~1464 tok)
- `context.ts` — Active terminal tab cwd, used to resolve relative paths. Null = home. (~477 tok)
- `edit.ts` — Exports buildEditTools (~1738 tok)
- `fs.ts` — Exports buildFsTools (~2226 tok)
- `search.ts` — /*.tsx'].", (~1289 tok)
- `shell.ts` — Per-session lazy shell-session id. The agent gets one persistent shell per (~1541 tok)
- `subagent.ts` — Exports buildSubagentTools (~586 tok)
- `terminal.ts` — Exports buildTerminalTools (~1264 tok)
- `todo.ts` — Zod schemas: TodoStatus (~576 tok)
- `tools.ts` — AI tool definitions. (~475 tok)

## src/modules/debugger/

- `index.ts` (~113 tok)
- `index.ts` — Exports DebugDock, debuggerEditorExtension, useDebuggerStore, probesForFile (~60 tok)

## src/modules/debugger/components/

- `ConsoleView.tsx` — Program output + a REPL evaluating in the selected paused frame. (~939 tok)
- `ConsoleView.tsx` — Program output + REPL evaluating in the selected paused frame, history (~700 tok)
- `DebugDock.tsx` — The debugger's bottom dock: a header with run controls and the frame (~6858 tok)
- `DebugDock.tsx` — Bottom dock: drag-resize, header (step controls + frame breadcrumb), two toggleable slots Map⇄Frames | Variables⇄Console (~1800 tok)
- `DebugPill.tsx` — Statusbar pill: starts debugging the active .py file / reopens the dock. (~659 tok)
- `DebugPill.tsx` — Statusbar entry point: starts debugging active .py (root via lsp_resolve_root), reopens dock (~700 tok)
- `FramesView.tsx` — Full call-stack list; the header breadcrumb covers the common case. (~415 tok)
- `FramesView.tsx` — Full call-stack list, click selects frame + opens source (~350 tok)
- `GraphView.tsx` — The execution map: functions the run actually passed through, layered by (~2423 tok)
- `GraphView.tsx` — Live SVG execution map: layered nodes with hit counts/ret shapes, anomaly borders (NaN red, shape-change amber) (~1500 tok)
- `McpBridge.tsx` — Headless bridge between the Rust MCP server and the debugger store. (~901 tok)
- `ProbePopover.tsx` — Right-click probe editor: floats at the gutter contextmenu position and (~2269 tok)
- `ValueBadge.tsx` — One-line value summary with tensor/anomaly color coding. (~254 tok)
- `ValueBadge.tsx` — One-line ValueDesc badge with tensor/NaN color coding (~250 tok)
- `VariablesView.tsx` — Right slot: live frame variables when paused; otherwise the inspector for (~2550 tok)
- `VariablesView.tsx` — Paused: lazy DAP variable tree; running/ended: selected node inspector or crash report with shape-annotated locals (~1600 tok)

## src/modules/debugger/lib/

- `dapClient.ts` — DAP connection over the Rust framed-process transport (`lsp_spawn` — DAP (~1391 tok)
- `dapClient.ts` — DAP connection over the Rust lsp_spawn framed transport; request/response/event correlation, reverse-request decline (~1100 tok)
- `editorExtension.ts` — Editor integration: probe gutter (click = breakpoint, Alt/⌥-click = (~1818 tok)
- `editorExtension.ts` — CM6 extension: probe gutter (click=breakpoint ●, alt-click=tracepoint ◆), paused-line highlight + scroll, store sync (~1000 tok)
- `graphModel.test.ts` — Declares node (~1491 tok)
- `graphModel.test.ts` — Vitest: graph merge, snapshot ring, layout, demux chunk-splitting (~1200 tok)
- `graphModel.ts` — Snapshots kept per probe; oldest evicted beyond this. (~1833 tok)
- `graphModel.ts` — Pure execution-map fold (applyTraceEvents), layered DAG layout with back-edge handling, value formatters (~1500 tok)
- `interpreter.ts` — Per-root interpreter override for debug runs, picked from the dock. (~550 tok)
- `launch.ts` — How many ancestors the remote marker walk climbs before giving up. (~682 tok)
- `mcpBridge.test.ts` — tensor: resetStore, pauseAt (~4646 tok)
- `mcpBridge.ts` — MCP tool dispatch: executes bridged `terax:mcp-request` calls against the (~5166 tok)
- `probeRemap.test.ts` — doc: apply (~782 tok)
- `probeRemap.ts` — Remaps probe line numbers across a document edit. (~426 tok)
- `runLog.ts` — Run persistence: every debug run's raw TraceEvent stream is appended to (~1794 tok)
- `session.ts` — One write per app run per workspace; rewrites keep it current. (~3902 tok)
- `session.ts` — DebugSession orchestrator: venv-aware python resolve, tracer asset write, initialize→launch→setBreakpoints(logpoints)→configurationDone, stopped/output handling, step/eval API (~2000 tok)
- `sshRouting.test.ts` — Declares SSH (~961 tok)
- `store.ts` — Anchor for the probe config popover (opened from the editor gutter). (~5336 tok)
- `store.ts` — useDebuggerStore (zustand): probes per file, session status, graph state, paused frames/variables, console, dock slot state (~1800 tok)
- `traceEvents.ts` — Splits debug-adapter output into tracer events and plain console text. (~609 tok)
- `traceEvents.ts` — OutputDemux: splits @@TERAX_DBG@@ tracer JSONL out of DAP output events, buffers partial lines per category (~500 tok)
- `types.ts` — Compact value summary produced by terax_debug.py's describe(). (~975 tok)
- `types.ts` — ValueDesc/TraceEvent/Probe/DAP-subset types shared across the debugger (~900 tok)

## src/modules/debugger/python/

- `terax_debug.py` — Terax debug bootstrap + execution tracer. (~6439 tok)
- `terax_debug.py` — Debug bootstrap + tracer (imported ?raw, written to appCacheDir): sys.setprofile call-graph scoped to project root, __terax_snap logpoint probe, torch/numpy describe with stats + identity (id/ptr/_version), crash report, JSONL events on stderr (~3200 tok)
- `test_terax_debug.py` — Unit tests for the Terax debug tracer/snapshot helper. (~2773 tok)
- `test_terax_debug.py` — pytest (torch-optional): describe edge cases, NaN JSON safety, tracer graph/ring/site-packages filter, in-place vs rebind identity (~1700 tok)

## src/modules/editor/

- `AiDiffPane.tsx` — SHARED_EXT — uses useMemo, useEffect (~2081 tok)
- `AiDiffStack.tsx` — AiDiffStack (~246 tok)
- `AiDiffStackLazy.tsx` — AiDiffStackInner (~133 tok)
- `EditorPane.tsx` — Open CodeMirror's find/replace panel. (~5029 tok)
- `EditorStack.tsx` — EditorStack — uses useRef, useEffect (~1004 tok)
- `EditorStackLazy.tsx` — EditorStackInner (~133 tok)
- `GitDiffPane.tsx` — LARGE_FILE_THRESHOLD — uses useEffect, useMemo (~3042 tok)
- `GitDiffStack.tsx` — GitDiffStack (~344 tok)
- `GitDiffStackLazy.tsx` — GitDiffStackInner (~136 tok)
- `index.ts` (~74 tok)
- `NewEditorDialog.tsx` — joinPath — renders modal — uses useState, useEffect (~999 tok)

## src/modules/editor/lib/

- `colorSwatches.ts` — Exports colorSwatches (~878 tok)
- `diffCache.ts` — Exports getCachedDiff, invalidateDiff, invalidateRepoDiffs, workingDiffKey + 3 more (~733 tok)
- `extensions.ts` — Compartments allow runtime reconfiguration without rebuilding state. (~992 tok)
- `languageResolver.ts` — Extension → loader. Each loader is a dynamic import so language packs (~1889 tok)
- `themes.ts` — Exports EDITOR_THEME_EXT (~254 tok)
- `useDocument.ts` — Exports DocumentState, useDocument (~1547 tok)
- `vim.ts` — A CodeMirror extension that binds :w / :q handlers to this view. (~585 tok)

## src/modules/editor/lib/autocomplete/

- `codexAutocomplete.integration.test.ts` — Integration tests — Codex autocomplete end-to-end via the real HTTP endpoint. (~2159 tok)
- `inlineExtension.ts` — Exports AutocompletePrefs, AutocompleteContext (~3891 tok)
- `prompt.ts` — Exports CompletionRequest, trimContext, COMPLETION_SYSTEM_PROMPT, buildUserPrompt (~674 tok)
- `provider.ts` — Exports CompletionDeps, requestCompletion (~984 tok)

## src/modules/explorer/

- `DragGhost.tsx` — A small badge pinned next to the cursor while dragging file(s) in the tree, (~416 tok)
- `ExplorerSearch.tsx` — MIN_QUERY_LEN — uses useState, useRef, useEffect (~3041 tok)
- `FileExplorer.tsx` — ROW_HEIGHT (~6917 tok)
- `index.ts` — Declares FileExplorerHandle (~36 tok)
- `InlineInput.tsx` — Self-focusing single-line input for rename / create flows in the tree. (~848 tok)
- `TreeRow.tsx` — Ordered current selection — used to compute multi-target context actions. (~3796 tok)

## src/modules/explorer/lib/

- `constants.ts` — Extension → VS Code language id, used by `iconResolver` as a fallback when (~444 tok)
- `contextActions.ts` — Save a remote (SSH) file to the local machine via a native save dialog. (~2522 tok)
- `dropTarget.ts` — What the in-tree drag is carrying, for the cursor ghost. (~525 tok)
- `fileIcons.ts` — Default file icon associations (~16180 tok)
- `folderIcons.ts` — Default folder icon associations (~3017 tok)
- `iconResolver.ts` — Exports fileIconUrl, folderIconUrl (~956 tok)
- `menuItemClass.ts` — Compact override for shadcn ContextMenuItem inside the file explorer. (~98 tok)
- `useExplorerFileDrop.ts` — Wires native OS file drops onto the file-explorer tree: highlights the folder (~774 tok)
- `useFileTree.ts` — Exports DirEntry, PendingCreate, joinPath, dirname, useFileTree (~3828 tok)
- `watch.ts` — Exports watchAdd, watchRemove, listenFsChanged, parentDir (~308 tok)

## src/modules/file-preview/

- `FilePreviewPane.tsx` — base64ToBytes (~2375 tok)
- `FilePreviewStack.tsx` — FilePreviewStack (~254 tok)
- `index.ts` — Declares PreviewKind (~64 tok)
- `PdfViewer.tsx` — In-app PDF renderer built on pdf.js. The webview cannot show PDFs natively (~3667 tok)
- `previewable.ts` — "image" / "pdf" when the path can be shown in a file-preview tab. (~276 tok)
- `usePinchZoom.ts` — Wires trackpad pinch (and ctrl+wheel) on `ref` to a zoom setter, anchoring (~1090 tok)

## src/modules/git-history/

- `GitHistoryPane.tsx` — Lets the header search bar drive commit filtering for the active pane. (~9516 tok)
- `GitHistoryStack.tsx` — GitHistoryStack (~259 tok)
- `GitHistoryStackLazy.tsx` — GitHistoryStackInner (~144 tok)
- `GraphRail.tsx` — LANE_WIDTH (~1057 tok)
- `index.ts` (~35 tok)

## src/modules/git-history/lib/

- `graph.ts` — Compute graph rows. Pass the previous tail state when appending a new page (~1866 tok)
- `remoteWebUrl.ts` — Exports RemoteWebHost, RemoteWebInfo, parseRemoteWebUrl, commitWebUrl, hostLabel (~573 tok)

## src/modules/header/

- `Header.tsx` — Promote a preview (transient) tab to persistent. (~2087 tok)
- `index.ts` — Declares SearchInlineHandle (~38 tok)
- `SearchInline.tsx` — When true, collapse to an icon-only button until the user opens it. (~2294 tok)

## src/modules/lsp/

- `index.ts` — Declares LspPreset (~143 tok)

## src/modules/lsp/components/

- `LspStatusPill.tsx` — Venv path (Python servers only) + format-on-save toggle, shown inside the (~3778 tok)

## src/modules/lsp/lib/

- `client.ts` — Effective bindings for a shortcut: the user's override if set, else the (~2282 tok)
- `detect.ts` — Resolve the absolute binary a server will actually spawn, preferring a (~804 tok)
- `root.ts` — How many ancestors the remote marker walk climbs before giving up. Mirrors (~440 tok)
- `sessionManager.ts` — Exports LspDocHandle, acquireDocExtension, notifyDocumentSaved, stopPresetSessions (~4062 tok)
- `useLspHint.ts` — Exports LspHint, useLspHint (~1019 tok)

## src/modules/markdown/

- `index.ts` (~32 tok)
- `MarkdownPreviewPane.tsx` — components — uses useEffect (~815 tok)
- `MarkdownStack.tsx` — MarkdownStack (~252 tok)

## src/modules/preview/

- `index.ts` — Declares PreviewPaneHandle (~30 tok)
- `PreviewAddressBar.tsx` — PORT_PRESETS — uses useState, useEffect (~2172 tok)
- `PreviewPane.test.ts` — Source-level regression test for the preview iframe's security attributes. (~698 tok)
- `PreviewPane.tsx` — SUSPEND_AFTER_MS — uses useState, useEffect (~1815 tok)
- `PreviewStack.tsx` — PreviewStack — uses useRef, useEffect (~694 tok)

## src/modules/settings/

- `openSettingsWindow.ts` — Exports SettingsTab, openSettingsWindow (~86 tok)
- `preferences.ts` — Subscribe & hydrate. Idempotent — safe to call from multiple windows. (~549 tok)
- `store.ts` — languageResolver id -> LSP languageId (~9079 tok)

## src/modules/shortcuts/

- `index.ts` — Declares Shortcut (~76 tok)
- `shortcuts.ts` — Single source of truth for keyboard shortcuts. (~3142 tok)
- `ShortcutsDialog.tsx` — ShortcutsDialog — renders modal (~1122 tok)

## src/modules/shortcuts/lib/

- `useGlobalShortcuts.ts` — Exports ShortcutHandler, ShortcutHandlers, UseGlobalShortcutsOptions, useGlobalShortcuts (~433 tok)

## src/modules/sidebar/

- `index.ts` (~32 tok)
- `SidebarRail.tsx` — SIDEBAR_RAIL_HEIGHT (~712 tok)
- `types.ts` — Exports SidebarViewId (~17 tok)

## src/modules/source-control/

- `index.ts` — Declares SourceControlSummary (~53 tok)
- `SourceControlPanel.tsx` — SOURCE_CONTROL_TOOLTIP_CLASS — uses useState, useEffect, useMemo, useCallback (~10706 tok)
- `SourceControlPanelLazy.tsx` — SourceControlPanelInner (~153 tok)
- `useSourceControl.ts` — Exports SourceControlRefreshMode, SourceControlRemoteAction, SourceControlRemoteActionMode, SourceControlRemoteActionResult + 4 more (~4150 tok)
- `useSourceControlPanel.ts` — One row per changed file (flat list) — merges the staged/unstaged split. (~8955 tok)

## src/modules/statusbar/

- `AiTools.tsx` — MODELS — uses useState (~1046 tok)
- `CwdBreadcrumb.tsx` — dirname (~2516 tok)
- `index.ts` (~12 tok)
- `SshRemoteSelector.tsx` — VS Code-style remote indicator: connects the whole window to an SSH host. (~2431 tok)
- `StatusBar.tsx` — Only rendered when the AI panel is open and a key is loaded. (~1100 tok)
- `WorkspaceEnvSelector.tsx` — WorkspaceEnvSelector (~819 tok)

## src/modules/statusbar/lib/

- `pathUtils.ts` — Root anchor (~ / drive / "/"). Always shown. (~666 tok)

## src/modules/tabs/

- `index.ts` — Declares Tab (~113 tok)
- `TabBar.tsx` — The file path (or terminal cwd) a tab maps to, for copy-path actions. (~5237 tok)

## src/modules/tabs/lib/

- `fileTabs.test.ts` — FileBackedKind: terminal, fileTab (~1490 tok)
- `fileTabs.ts` — Functional core for opening file-backed tabs (editor, markdown, image/PDF (~1221 tok)
- `tabLabel.ts` — The label shown on a tab. Non-terminal tabs use their stored title; terminal (~170 tok)
- `useTabs.ts` — AI agent cannot read buffer / context of this terminal. (~6855 tok)
- `useWorkspaceCwd.ts` — Exports useWorkspaceCwd (~401 tok)

## src/modules/terminal/

- `index.ts` — Declares TerminalPaneHandle (~179 tok)
- `PaneTreeView.tsx` — Renders terminal pane trees with divider-centered split merge controls. (~650 tok)
- `PortForwardBridge.tsx` — Manually forward a port the user typed in. Only valid in an SSH workspace (~2096 tok)
- `TerminalPane.tsx` — Stable identifier for this leaf (passed back through callbacks). (~1578 tok)
- `TerminalStack.tsx` — Stacks terminal tabs and forwards pane focus/search/cwd/merge handlers. (~877 tok)

## src/modules/terminal/lib/

- `clipboardPaste.ts` — Clipboard paste into a terminal, with image support for SSH workspaces. (~974 tok)
- `dormantRing.ts` — Exports DormantRing (~530 tok)
- `fileLinkMatch.test.ts` — Declares LOCAL (~686 tok)
- `fileLinkMatch.ts` — Pure matching/resolution logic for terminal file links. Kept free of Tauri (~689 tok)
- `fileLinks.ts` — Clickable file links in the terminal for previewable files (images, PDFs). (~859 tok)
- `hebrewRtl.test.ts` — Declares transform (~1057 tok)
- `hebrewRtl.ts` — xterm paints terminal cells in column order and does not apply the Unicode (~2583 tok)
- `keymap.test.ts` — Declares TerminalKeyEvent (~1009 tok)
- `keymap.ts` — Cmd+Left/Right → readline line-start (Ctrl+A) / line-end (Ctrl+E). (~487 tok)
- `osc-handlers.test.ts` — Minimal in-memory fake of the xterm `Terminal` surface we touch — just (~1033 tok)
- `osc-handlers.ts` — Cross-handler state shared between the OSC 7 cwd handler and the OSC 133 (~815 tok)
- `panes.ts` — Terminal pane tree helpers for split, remove leaf, remove split side, focus. (~1200 tok)
- `pty-bridge.ts` — Exports PtyHandlers, PtySession, openPty (~446 tok)
- `rendererPool.ts` — Last-known cwd of the leaf's shell (OSC 7 / SSH poll), for file links. (~6776 tok)
- `useTerminalSession.ts` — Clear the scrollback and screen of the currently focused terminal, keeping (~6595 tok)

## src/modules/theme/

- `applyTheme.ts` — Exports applyTheme, clearTheme (~960 tok)
- `bgImageStore.ts` — Exports putBgImage, getBgImage, deleteBgImage, importBgImageFromFile (~1557 tok)
- `customThemes.ts` — Exports listCustomThemes, saveCustomTheme, deleteCustomTheme, onCustomThemesChange (~389 tok)
- `index.ts` — Declares Theme (~21 tok)
- `SurfaceLayer.tsx` — OVERLAY_Z — uses useState, useEffect (~1282 tok)
- `themeFiles.ts` — Exports ThemeEditRequest, isThemeFilePath, themeFilePath, writeThemeFile + 5 more (~993 tok)
- `ThemeProvider.tsx` — ThemeProviderContext — uses useEffect, useCallback, useContext (~1605 tok)
- `types.ts` — Exports ThemeMode, ThemeColors, TerminalPalette, ThemeVariant + 2 more (~400 tok)
- `validateTheme.ts` — Exports ValidationResult, validateTheme (~1357 tok)

## src/modules/theme/themes/

- `caffeine.ts` — Exports caffeine (~812 tok)
- `catppuccin.ts` — Exports catppuccin (~820 tok)
- `claude.ts` — Exports claude (~829 tok)
- `gruvbox.ts` — Exports gruvbox (~817 tok)
- `index.ts` — Exports listBuiltinThemes, getBuiltinTheme, getDefaultTheme (~260 tok)
- `nord.ts` — Exports nord (~750 tok)
- `rose-pine.ts` — Exports rosePine (~821 tok)
- `sage.ts` — Exports sage (~830 tok)
- `terax-default.ts` — Exports teraxDefault (~88 tok)
- `tide.ts` — Exports tide (~827 tok)
- `tokyo-night.ts` — Exports tokyoNight (~442 tok)

## src/modules/updater/

- `index.ts` (~27 tok)
- `UpdaterDialog.tsx` — distroCommand — renders modal — uses useState (~1638 tok)
- `useUpdater.ts` — Skip the time-based throttle on automatic startup checks. (~1290 tok)

## src/modules/workspace/

- `env.ts` — Liveness of the window's SSH link. Only meaningful when `env.kind === "ssh"`. (~1221 tok)
- `index.ts` — Declares SshConnectInfo (~101 tok)

## src/settings/

- `main.tsx` — showWindow (~266 tok)
- `SettingsApp.tsx` — TABS — uses useEffect (~1238 tok)

## src/settings/components/

- `LspServersGroup.tsx` — The main window mirrors its project root here so this window can scope the (~3542 tok)
- `ProviderIcon.tsx` — ICON_BY_PROVIDER (~310 tok)
- `ProviderKeyCard.tsx` — maskKey — uses useState, useEffect (~1876 tok)
- `ProviderOAuthCard.tsx` — Card for OAuth-authenticated providers (no API key required). (~1217 tok)
- `SectionHeader.tsx` — SectionHeader (~110 tok)
- `SettingRow.tsx` — SettingRow (~240 tok)

## src/settings/sections/

- `AboutSection.tsx` — REPO_URL — uses useState, useEffect (~1586 tok)
- `AgentsSection.tsx` — ICON_OPTIONS — renders modal — uses useEffect (~5298 tok)
- `GeneralSection.tsx` — APPEARANCE (~4533 tok)
- `ModelsSection.tsx` — LOCAL_PROVIDER_IDS — uses useEffect (~9542 tok)
- `ShortcutsSection.tsx` — ShortcutsSection (~2960 tok)
- `ThemesSection.tsx` — ThemesSection — uses useMemo (~3638 tok)

## src/styles/

- `code-highlight.css` — Styles: 65 rules, 34 vars (~988 tok)
- `fonts.css` — Styles: 2 rules (~221 tok)
- `globals.css` — Styles: 43 rules, 125 vars, 2 animations, 2 layers (~2890 tok)
- `terminalTheme.ts` — Exports buildTerminalTheme (~237 tok)
- `tokens.ts` — Exports TerminalTokens, readTerminalTokens (~655 tok)
