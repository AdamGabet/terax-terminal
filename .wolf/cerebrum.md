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

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->
- [2026-06-11] Dock "New Window" spawned a new app instance (`open -n`) → separate dock icon. Create an in-process WebviewWindow (label main-N) via a stored AppHandle instead.
- [2026-06-11] New sync Tauri commands doing remote I/O froze the UI ("file opens stuck"). Always async + spawn_blocking.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
- 2026-06-04: Did not add a custom AppKit `New Window` Dock menu item because Tauri lacks a simple API and the native delegate/runtime approach is too invasive for the requested scope.
- 2026-06-04: Implemented macOS dock "New Window" via `class_addMethod` on the Tauri app delegate class (`applicationDockMenu:` + `teraxNewWindow:` action). Uses `objc2 0.6` (already a transitive dep - zero extra binary size). Removed the Cmd+N in-app shortcut at user request.
