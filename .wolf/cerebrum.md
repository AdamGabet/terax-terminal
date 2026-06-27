# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-05-28

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->
- For terminal split panes, prefer controls on the split divider itself (small middle button / right-click menu) rather than per-pane corner close buttons.
- Avoid overcomplicated native macOS Dock menu runtime work unless explicitly requested; prefer existing Cmd+N/New Window UI plus Dock reopen/show handling.
- User removed Cmd+N as "New Window" shortcut (felt wrong/weird as an in-app hack). New Window is now dock-menu-only.

## Key Learnings

- **macOS dock menu**: Use `objc2::ffi::class_addMethod` on the Tauri app delegate class to add `applicationDockMenu:` (returns NSMenu) and a companion action selector. The delegate is available at `NSApplication.sharedApplication.delegate` during `setup()`. objc2 0.6.x uses `unsafe extern "C-unwind" fn` signatures and `c""` literals for type encodings.
- **Project:** terax
- **Description:** <div align="center">

- **Tauri sync commands run on the main thread**: any command that can be slow (network, tree walks) must be `async fn` + `tauri::async_runtime::spawn_blocking` (the pattern git/commands.rs uses). Sync fs commands froze the whole UI once SSH made them network roundtrips.
- **SSH remoting (WorkspaceEnv::Ssh)**: system OpenSSH with ControlMaster multiplexing (`~/.cache/terax/ssh/cm-%C`, ControlPersist 600); remote scripts are base64-wrapped (`echo B64 | base64 -d | sh`) so csh/tcsh login shells can't mis-parse them; fs ops go through a python3 JSON-lines agent installed at `~/.cache/terax/remote/agent.py` (version handshake, reinstalled every connect); terminal cwd tracking polls `/proc/<pid>/cwd` via the agent (pid file written by the PTY bootstrap) because OSC 7 from SSH output is untrusted and csh shells emit none.
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

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->
- [2026-06-11] Dock "New Window" spawned a new app instance (`open -n`) → separate dock icon. Create an in-process WebviewWindow (label main-N) via a stored AppHandle instead.
- [2026-06-11] New sync Tauri commands doing remote I/O froze the UI ("file opens stuck"). Always async + spawn_blocking.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
- 2026-06-04: Did not add a custom AppKit `New Window` Dock menu item because Tauri lacks a simple API and the native delegate/runtime approach is too invasive for the requested scope.
- 2026-06-04: Implemented macOS dock "New Window" via `class_addMethod` on the Tauri app delegate class (`applicationDockMenu:` + `teraxNewWindow:` action). Uses `objc2 0.6` (already a transitive dep - zero extra binary size). Removed the Cmd+N in-app shortcut at user request.
- [2026-06-12] tauri.conf.json CSP has `object-src 'none'` — `<embed>`/`<object>` never render anything (this silently killed the PDF preview). Render in-app instead (pdf.js for PDFs).
- [2026-06-12] Clipboard image → remote Claude Code: no protocol exists (OSC 52 is text-only; Claude Code declined kitty OSC 5522, issue #42712). The ecosystem-standard fix is upload-to-remote-temp-file + paste absolute path; Claude Code auto-attaches images from pasted absolute paths.
- [2026-06-12] When adding an SSH agent op, bump AGENT_VERSION in BOTH src-tauri/src/modules/ssh/agent.py and agent.rs (version handshake kills the connection otherwise).

## Decision Log — tmux Tabs (2026-06-23)
- User chose **Option B** over Option A for the tmux feature: normal tabs stay plain shells; only explicitly-created "tmux tabs" persist. Rationale: avoids forcing a tmux server on every terminal, and matches the "+ dropdown adds a tmux-tab option" UX. Closing a tmux tab detaches (not kills); killing is done via a list popover. No process reparenting (not portable). SSH targets remote tmux over the existing ControlMaster connection. Spec: tmux_spec.md.
