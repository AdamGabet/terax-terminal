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
