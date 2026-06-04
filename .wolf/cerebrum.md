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

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
- 2026-06-04: Did not add a custom AppKit `New Window` Dock menu item because Tauri lacks a simple API and the native delegate/runtime approach is too invasive for the requested scope.
- 2026-06-04: Implemented macOS dock "New Window" via `class_addMethod` on the Tauri app delegate class (`applicationDockMenu:` + `teraxNewWindow:` action). Uses `objc2 0.6` (already a transitive dep - zero extra binary size). Removed the Cmd+N in-app shortcut at user request.
