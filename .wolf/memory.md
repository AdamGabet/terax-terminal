# Memory

> Chronological action log. Hooks and AI append to this file automatically.
> Old sessions are consolidated by the daemon weekly.

| 11:42 | Fixed codex token expiry bug — re-fetch token per request in codexFetch | src/modules/ai/lib/agent.ts | done | ~300 tok |
| 11:42 | Fixed env block accumulation across turns — strip old blocks before injecting fresh one | src/modules/ai/lib/transport.ts | done | ~200 tok |
| 11:42 | Fixed originator → openai-originator header name | src/modules/ai/lib/agent.ts | done | ~50 tok |

- 2026-06-01: Fixed AI chat approval interruption by tracking pending approval IDs and denying them before submitting a new user message.
- 2026-06-04: Added divider-centered terminal split merge controls with keep-left/right/top/bottom actions, plus a New Window action that spawns a separate Terax process; verified with TypeScript and Rust checks.
- 2026-06-04: Tuned xterm scroll sensitivity and smooth-scroll duration to make opencode/TUI terminal scrolling feel less jumpy; verified with TypeScript.
- 2026-06-04: Added macOS Dock reopen handling so Dock right-click/show-window actions reveal, unminimize, and focus the main Terax window; falls back to a new Terax process if needed.
- 2026-06-04: Skipped custom native `New Window` Dock menu item after review because it requires invasive AppKit delegate/runtime work; removed exploratory objc dependencies and kept the safer Dock reopen fix.

## Session: 2026-06-04 11:23

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|

## Session: 2026-06-04 11:23

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|

## Session: 2026-06-04 11:35

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|

## Session: 2026-06-04 11:39

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|
| 11:42 | Edited src/modules/ai/lib/agent.ts | modified if() | ~481 |
| 11:42 | Edited src/modules/ai/lib/transport.ts | added 2 condition(s) | ~378 |
| 11:45 | Edited src-tauri/src/modules/shell/mod.rs | modified shell_rtk_rewrite() | ~203 |
| 11:45 | Edited src-tauri/src/lib.rs | 1→2 lines | ~20 |
| 11:46 | Edited src/modules/ai/lib/native.ts | 1→3 lines | ~49 |
| 11:47 | Edited src/modules/ai/tools/shell.ts | modified catch() | ~280 |
| 11:47 | Edited src/modules/ai/tools/shell.ts | modified catch() | ~154 |
| 11:47 | Session end: 7 writes across 6 files (agent.ts, transport.ts, mod.rs, lib.rs, native.ts) | 11 reads | ~24488 tok |
| 12:00 | Edited src/modules/shortcuts/shortcuts.ts | 4→3 lines | ~17 |
| 12:00 | Edited src/modules/shortcuts/shortcuts.ts | removed 7 lines | ~1 |
| 12:01 | Edited src/app/App.tsx | removed 7 lines | ~8 |
| 12:01 | Edited src/app/App.tsx | 3→2 lines | ~21 |
| 12:01 | Edited src/app/App.tsx | 3→2 lines | ~12 |
| 12:01 | Edited src/app/App.tsx | 3→2 lines | ~22 |
| 12:01 | Edited src/modules/header/Header.tsx | 3→2 lines | ~14 |
| 12:02 | Edited src/modules/header/Header.tsx | 3→2 lines | ~7 |
| 12:02 | Edited src/modules/header/Header.tsx | 3→2 lines | ~18 |
| 12:02 | Edited src/modules/tabs/TabBar.tsx | 3→2 lines | ~14 |
| 12:02 | Edited src/modules/tabs/TabBar.tsx | 3→2 lines | ~7 |
| 12:02 | Edited src/modules/tabs/TabBar.tsx | removed 12 lines | ~18 |
| 12:02 | Edited src-tauri/Cargo.toml | 4→5 lines | ~41 |
| 12:03 | Edited src-tauri/src/lib.rs | modified setup_dock_menu() | ~846 |
| 12:03 | Edited src-tauri/src/lib.rs | modified get_webview_window() | ~143 |
| 12:04 | Edited src-tauri/src/lib.rs | inline fix | ~25 |
| 12:04 | Edited src-tauri/src/lib.rs | inline fix | ~25 |
| 12:04 | Edited src-tauri/src/lib.rs | "NSApplication\0" → "NSApplication" | ~17 |
| 12:05 | Edited src-tauri/src/lib.rs | 7→7 lines | ~82 |
| 12:05 | Edited src-tauri/src/lib.rs | 22→20 lines | ~235 |
| 12:05 | Edited src-tauri/src/lib.rs | 4→3 lines | ~35 |
| 12:05 | Removed tab.newWindow shortcut (Cmd+N) from shortcuts.ts, App.tsx, Header.tsx, TabBar.tsx; added macOS dock right-click "New Window" via AppKit/objc2 class_addMethod on Tauri delegate | src/modules/shortcuts/shortcuts.ts, src/app/App.tsx, src/modules/header/Header.tsx, src/modules/tabs/TabBar.tsx, src-tauri/Cargo.toml, src-tauri/src/lib.rs | success, tsc+clippy clean | ~3200 |
| 12:07 | Session end: 28 writes across 11 files (agent.ts, transport.ts, mod.rs, lib.rs, native.ts) | 16 reads | ~48238 tok |
| 12:09 | Edited src-tauri/src/lib.rs | modified open_new_window() | ~222 |
| 12:09 | Edited src-tauri/src/lib.rs | inline fix | ~15 |
| 12:09 | Session end: 30 writes across 11 files (agent.ts, transport.ts, mod.rs, lib.rs, native.ts) | 16 reads | ~48492 tok |
| 12:11 | Session end: 30 writes across 11 files (agent.ts, transport.ts, mod.rs, lib.rs, native.ts) | 16 reads | ~48492 tok |
| 12:13 | Session end: 30 writes across 11 files (agent.ts, transport.ts, mod.rs, lib.rs, native.ts) | 16 reads | ~48492 tok |

## Session: 2026-06-11 18:10

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|
| 18:25 | Edited src-tauri/src/modules/workspace.rs | modified from_option() | ~179 |
| 18:25 | Edited src-tauri/src/modules/workspace.rs | modified resolve_path() | ~119 |
| 18:25 | Edited src-tauri/src/modules/workspace.rs | modified authorize_spawn_cwd() | ~126 |
| 18:25 | Edited src-tauri/src/modules/workspace.rs | modified authorize_user_spawn_cwd() | ~86 |
| 18:25 | Edited src-tauri/src/modules/workspace.rs | modified workspace_authorize() | ~116 |
| 18:28 | Created src-tauri/src/modules/ssh/mod.rs | — | ~4100 |
| 18:28 | Created src-tauri/src/modules/ssh/agent.rs | — | ~2166 |
| 18:29 | Created src-tauri/src/modules/ssh/agent.py | — | ~5056 |
| 18:30 | Created src-tauri/src/modules/ssh/fsops.rs | — | ~2134 |
| 18:30 | Edited src-tauri/src/modules/mod.rs | 2→3 lines | ~12 |
| 18:30 | Edited src-tauri/src/modules/fs/tree.rs | modified fs_read_dir() | ~100 |
| 18:31 | Edited src-tauri/src/modules/fs/tree.rs | modified list_subdirs() | ~100 |
| 18:31 | Edited src-tauri/src/modules/fs/file.rs | modified fs_read_file() | ~90 |
| 18:31 | Edited src-tauri/src/modules/fs/file.rs | modified ssh_host() | ~209 |
| 18:31 | Edited src-tauri/src/modules/fs/file.rs | modified fs_canonicalize() | ~87 |
| 18:31 | Edited src-tauri/src/modules/fs/file.rs | modified fs_stat() | ~83 |
| 18:31 | Edited src-tauri/src/modules/fs/mutate.rs | modified fs_create_file() | ~85 |
| 18:31 | Edited src-tauri/src/modules/fs/mutate.rs | modified fs_create_dir() | ~84 |
| 18:31 | Edited src-tauri/src/modules/fs/mutate.rs | modified fs_rename() | ~88 |
| 18:31 | Edited src-tauri/src/modules/fs/mutate.rs | modified fs_delete() | ~82 |
| 18:31 | Edited src-tauri/src/modules/fs/grep.rs | modified is_empty() | ~177 |
| 18:31 | Edited src-tauri/src/modules/fs/grep.rs | modified is_empty() | ~128 |
| 18:31 | Edited src-tauri/src/modules/fs/search.rs | modified ssh_host() | ~117 |
| 18:32 | Edited src-tauri/src/modules/fs/search.rs | modified ssh_host() | ~144 |
| 18:32 | Edited src-tauri/src/modules/fs/watch.rs | modified ssh_host() | ~127 |
| 18:32 | Edited src-tauri/src/modules/fs/watch.rs | modified ssh_host() | ~86 |
| 18:32 | Edited src-tauri/src/modules/git/process.rs | modified workspace_cache_key() | ~71 |
| 18:32 | Edited src-tauri/src/modules/git/process.rs | modified build_git_command() | ~288 |
| 18:32 | Edited src-tauri/src/modules/git/utils.rs | modified canonical_dir() | ~152 |
| 18:32 | Edited src-tauri/src/modules/git/utils.rs | modified authorized_repo_root() | ~124 |
| 18:33 | Edited src-tauri/src/modules/git/operations.rs | modified resolve_pathspecs() | ~570 |
| 18:33 | Edited src-tauri/src/modules/git/operations.rs | 4→4 lines | ~40 |
| 18:33 | Edited src-tauri/src/modules/git/operations.rs | 12→8 lines | ~92 |
| 18:33 | Edited src-tauri/src/modules/git/operations.rs | 3→6 lines | ~73 |
| 18:33 | Edited src-tauri/src/modules/git/operations.rs | 2→2 lines | ~34 |
| 18:33 | Edited src-tauri/src/modules/git/operations.rs | 2→2 lines | ~40 |
| 18:34 | Edited src-tauri/src/modules/git/operations.rs | inline fix | ~19 |
| 18:34 | Edited src-tauri/src/modules/git/operations.rs | reduced (-10 lines) | ~58 |
| 18:34 | Edited src-tauri/src/modules/git/operations.rs | modified is_authorized() | ~79 |
| 18:34 | Edited src-tauri/src/modules/git/operations.rs | modified is_authorized() | ~79 |
| 18:34 | Edited src-tauri/src/modules/git/operations.rs | 5→5 lines | ~80 |
| 18:34 | Edited src-tauri/src/modules/shell/mod.rs | modified build_oneshot_command() | ~196 |
| 18:34 | Edited src-tauri/src/modules/shell/mod.rs | added optional chaining | ~136 |
| 18:34 | Edited src-tauri/src/modules/shell/session.rs | modified load() | ~158 |
| 18:34 | Edited src-tauri/src/modules/shell/session.rs | modified is_dir() | ~85 |
| 18:34 | Edited src-tauri/src/modules/shell/session.rs | modified wrap_with_sentinel() | ~55 |
| 18:34 | Edited src-tauri/src/modules/shell/background.rs | modified is_dir() | ~71 |
| 18:35 | Edited src-tauri/src/modules/pty/shell_init.rs | modified build_command() | ~778 |
| 18:36 | Edited src-tauri/src/lib.rs | modified create_main_window() | ~394 |
| 18:36 | Edited src-tauri/src/lib.rs | modified new_window_imp() | ~123 |
| 18:36 | Edited src-tauri/src/lib.rs | modified open_new_window() | ~165 |
| 18:36 | Edited src-tauri/src/lib.rs | 2→3 lines | ~33 |
| 18:36 | Edited src-tauri/src/lib.rs | 3→7 lines | ~64 |
| 18:36 | Edited src-tauri/src/lib.rs | added 1 import(s) | ~48 |
| 18:36 | Edited src-tauri/src/modules/pty/mod.rs | expanded (+7 lines) | ~127 |
| 18:37 | Edited src-tauri/src/modules/pty/mod.rs | modified pty_open() | ~94 |
| 18:37 | Edited src-tauri/src/modules/pty/mod.rs | expanded (+6 lines) | ~64 |
| 18:37 | Edited src-tauri/src/modules/pty/mod.rs | 10→10 lines | ~69 |
| 18:37 | Edited src-tauri/src/modules/pty/mod.rs | 10→10 lines | ~70 |
| 18:37 | Edited src-tauri/src/modules/pty/mod.rs | modified pty_close() | ~52 |
| 18:37 | Edited src-tauri/src/modules/pty/mod.rs | 6→6 lines | ~75 |
| 18:37 | Edited src-tauri/src/modules/pty/mod.rs | modified pty_close_all() | ~230 |
| 18:37 | Edited src-tauri/capabilities/default.json | 4→5 lines | ~18 |
| 18:37 | Edited src-tauri/capabilities/desktop.json | 4→5 lines | ~18 |
| 18:38 | Edited src/modules/workspace/env.ts | expanded (+12 lines) | ~103 |
| 18:38 | Edited src/modules/workspace/env.ts | added 2 condition(s) | ~54 |
| 18:38 | Edited src/modules/workspace/env.ts | modified getWslHome() | ~194 |
| 18:38 | Edited src/modules/workspace/index.ts | expanded (+6 lines) | ~85 |
| 18:40 | Created src/modules/statusbar/SshRemoteSelector.tsx | — | ~1998 |
| 18:40 | Edited src/modules/statusbar/StatusBar.tsx | added 1 import(s) | ~48 |
| 18:40 | Edited src/modules/statusbar/StatusBar.tsx | 3→4 lines | ~76 |
| 18:41 | Edited src/app/App.tsx | 7→9 lines | ~50 |
| 18:41 | Edited src/app/App.tsx | 7→3 lines | ~28 |
| 18:41 | Edited src/app/App.tsx | added 1 condition(s) | ~112 |
| 18:42 | Edited src-tauri/src/modules/ssh/agent.rs | 3→2 lines | ~17 |
| 18:42 | Edited src-tauri/src/modules/ssh/agent.rs | modified spawn() | ~166 |
| 18:42 | Edited src-tauri/src/modules/ssh/agent.rs | emit() → on_fs_changed() | ~36 |
| 18:42 | Edited src-tauri/src/modules/ssh/mod.rs | modified agent() | ~186 |
| 18:42 | Edited src-tauri/src/modules/ssh/mod.rs | 2→7 lines | ~36 |
| 18:42 | Edited src-tauri/src/modules/ssh/mod.rs | modified remote_script_arg_is_single_line_shell_neutral() | ~857 |
| 18:51 | Edited src-tauri/src/modules/ssh/agent.py | 11→10 lines | ~37 |
| 18:51 | Edited src-tauri/src/modules/ssh/agent.py | modified op_pty_cwd() | ~182 |
| 18:51 | Edited src-tauri/src/modules/ssh/agent.py | 2→3 lines | ~23 |
| 18:51 | Edited src-tauri/src/modules/ssh/agent.rs | 2→2 lines | ~19 |
| 18:51 | Edited src-tauri/src/modules/pty/shell_init.rs | modified build_command() | ~70 |
| 18:51 | Edited src-tauri/src/modules/pty/shell_init.rs | modified build() | ~290 |
| 18:51 | Edited src-tauri/src/modules/pty/session.rs | inline fix | ~17 |
| 18:51 | Edited src-tauri/src/modules/ssh/mod.rs | modified pty_token() | ~68 |
| 18:52 | Edited src-tauri/src/modules/ssh/mod.rs | 3→4 lines | ~48 |
| 18:52 | Edited src-tauri/src/modules/pty/mod.rs | 19→24 lines | ~231 |
| 18:52 | Edited src-tauri/src/modules/pty/mod.rs | modified spawn_ssh_cwd_poller() | ~529 |
| 18:52 | Edited src/modules/terminal/lib/useTerminalSession.ts | added 3 condition(s) | ~210 |
| 18:52 | Edited src/modules/terminal/lib/useTerminalSession.ts | added 1 import(s) | ~42 |
| 18:53 | Edited src-tauri/src/modules/fs/file.rs | modified fs_read_file() | ~174 |
| 18:53 | Edited src-tauri/src/modules/fs/file.rs | modified fs_write_file() | ~164 |
| 18:53 | Edited src-tauri/src/modules/fs/file.rs | modified fs_canonicalize() | ~116 |
| 18:53 | Edited src-tauri/src/modules/fs/file.rs | modified fs_stat() | ~108 |
| 18:53 | Edited src-tauri/src/modules/fs/tree.rs | modified fs_read_dir() | ~135 |
| 18:53 | Edited src-tauri/src/modules/fs/tree.rs | modified list_subdirs() | ~139 |
| 18:54 | Edited src-tauri/src/modules/fs/mutate.rs | modified fs_create_file() | ~163 |
| 18:54 | Edited src-tauri/src/modules/fs/mutate.rs | modified fs_create_dir() | ~110 |
| 18:54 | Edited src-tauri/src/modules/fs/mutate.rs | modified fs_rename() | ~118 |
| 18:54 | Edited src-tauri/src/modules/fs/mutate.rs | modified fs_delete() | ~106 |
| 18:54 | Edited src-tauri/src/modules/fs/search.rs | modified fs_search() | ~202 |
| 18:54 | Edited src-tauri/src/modules/fs/search.rs | modified fs_list_files() | ~174 |
| 18:54 | Edited src-tauri/src/modules/fs/grep.rs | modified fs_grep() | ~225 |
| 18:54 | Edited src-tauri/src/modules/fs/grep.rs | modified fs_glob() | ~144 |
| 18:54 | Edited src-tauri/src/modules/fs/watch.rs | modified fs_watch_add() | ~206 |
| 18:54 | Edited src-tauri/src/modules/fs/watch.rs | modified fs_watch_remove() | ~137 |
| 18:58 | Edited src-tauri/src/lib.rs | 2→3 lines | ~50 |
| 18:58 | Edited src-tauri/src/modules/ssh/mod.rs | modified connection() | ~401 |
| 19:00 | Session end: 111 writes across 26 files (workspace.rs, mod.rs, agent.rs, agent.py, fsops.rs) | 37 reads | ~131862 tok |

## Session: 2026-06-11 19:01

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|
| 19:25 | Edited src-tauri/Cargo.toml | 2→3 lines | ~22 |
| 19:25 | Edited src-tauri/src/modules/fs/file.rs | 2→3 lines | ~51 |
| 19:25 | Edited src-tauri/src/modules/fs/file.rs | modified fs_read_file_base64() | ~386 |
| 19:25 | Edited src-tauri/src/modules/ssh/fsops.rs | inline fix | ~22 |
| 19:25 | Edited src-tauri/src/modules/ssh/fsops.rs | modified read_file_base64() | ~183 |
| 19:26 | Edited src-tauri/src/modules/ssh/agent.py | added 1 import(s) | ~41 |
| 19:26 | Edited src-tauri/src/modules/ssh/agent.py | modified op_read_file_b64() | ~115 |
| 19:26 | Edited src-tauri/src/modules/ssh/agent.py | 2→3 lines | ~30 |
| 19:26 | Edited src-tauri/src/modules/ssh/agent.rs | 2 → 3 | ~8 |
| 19:26 | Edited src-tauri/src/lib.rs | 2→3 lines | ~31 |
| 19:26 | Created src/modules/file-preview/previewable.ts | — | ~276 |
| 19:26 | Created src/modules/file-preview/FilePreviewPane.tsx | — | ~1164 |
| 19:26 | Created src/modules/file-preview/FilePreviewStack.tsx | — | ~254 |
| 19:26 | Created src/modules/file-preview/index.ts | — | ~64 |
| 19:27 | Edited src/modules/tabs/lib/useTabs.ts | expanded (+8 lines) | ~74 |
| 19:27 | Edited src/modules/tabs/lib/useTabs.ts | 6→7 lines | ~32 |
| 19:27 | Edited src/modules/tabs/lib/useTabs.ts | added 2 condition(s) | ~173 |
| 19:27 | Edited src/modules/tabs/lib/useTabs.ts | 3→4 lines | ~23 |
| 19:27 | Edited src/modules/tabs/index.ts | 1→2 lines | ~12 |
| 19:27 | Edited src/modules/tabs/TabBar.tsx | modified if() | ~30 |
| 19:28 | Created src/modules/terminal/lib/fileLinks.ts | — | ~1393 |
| 19:28 | Edited src/modules/terminal/lib/fileLinks.ts | 4→9 lines | ~98 |
| 19:28 | Edited src/modules/terminal/lib/rendererPool.ts | modified resolveLeaf() | ~81 |
| 19:28 | Edited src/modules/terminal/lib/rendererPool.ts | added optional chaining | ~81 |
| 19:28 | Edited src/modules/terminal/lib/rendererPool.ts | added 1 import(s) | ~37 |
| 19:28 | Edited src/modules/terminal/lib/rendererPool.ts | reduced (-7 lines) | ~27 |
| 19:28 | Edited src/modules/terminal/lib/rendererPool.ts | added optional chaining | ~75 |
| 19:28 | Edited src/modules/terminal/lib/useTerminalSession.ts | added nullish coalescing | ~69 |
| 19:29 | Edited src/app/App.tsx | added 1 import(s) | ~38 |
| 19:29 | Edited src/app/App.tsx | 3→4 lines | ~23 |
| 19:29 | Edited src/app/App.tsx | 1→2 lines | ~34 |
| 19:29 | Edited src/app/App.tsx | CSS: open, homeDir | ~204 |
| 19:29 | Edited src/app/App.tsx | expanded (+9 lines) | ~99 |
| 19:30 | Edited src/modules/terminal/index.ts | 1→2 lines | ~34 |
| 19:30 | Edited src/app/App.tsx | 3→4 lines | ~23 |
| 19:31 | Edited src/modules/tabs/lib/tabLabel.ts | reduced (-6 lines) | ~25 |
| 19:37 | Created src/modules/terminal/lib/fileLinkMatch.ts | — | ~689 |
| 19:37 | Created src/modules/terminal/lib/fileLinks.ts | — | ~859 |
| 19:37 | Created src/modules/terminal/lib/fileLinkMatch.test.ts | — | ~686 |
