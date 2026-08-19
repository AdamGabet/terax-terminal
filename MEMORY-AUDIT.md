# Memory / Resource Leak Audit

Scope: changes since fork point `e5c5f72` (upstream `crynta/terax-ai`).
Focus is on the ~6,200 lines of Rust added on top of upstream.

Severity key:
- **HIGH** — grows unbounded during normal daily use
- **MED** — grows under a common-but-not-constant condition
- **LOW** — bounded, or needs an unusual trigger
- **INFO** — by design, noted so it isn't rediscovered

Status: `open` / `fixed` / `wontfix`

---

## Audited

- [x] `pty/mod.rs`, `pty/session.rs` (+ frontend lifecycle)
- [x] `ssh/mod.rs`, `ssh/agent.rs`
- [x] `lsp.rs` (+ frontend `sessionManager.ts`) — clean
- [x] `mcp.rs` — clean
- [x] Frontend / WebView side — renderer pool, session store, module-level caches
- [x] `lib.rs` (multi-window lifecycle, macOS dock menu)
- [x] `ssh/fsops.rs`, `codex.rs`, `tmux.rs`, `port_scan.rs`, `clipboard_files.rs` — clean
- [x] `fs/watch.rs`, `git/process.rs` — clean

Audit complete. The last group holds no long-lived state at all: `tmux.rs` uses
`cmd.output()` (which waits), the others spawn nothing and keep no statics.
`fs/watch.rs` refcounts watchers and calls `unwatch` at zero; `git/process.rs`
TTL-prunes its availability cache on every access. The macOS dock-menu ObjC in
`lib.rs:59-81` gets manual retain/release right — `item` is released after
`addItem:` retains it, `menu` is autoreleased.

---

## Verdict

No unbounded heap growth found. Caches are LRU-capped nearly everywhere
(`DIFF_CACHE_LIMIT`, `CHATS_LRU_CAP`, `EXPANSION_CACHE_LIMIT`, `POOL_MAX_SIZE`),
the LSP layer reaps and deregisters correctly, and the terminal renderer pool
caps live xterm instances at 5 regardless of tab count.

What was unbounded is **fds, threads, and process-table slots** — L-001, L-002
and L-005 each accumulated one per event with no ceiling. Those exhaust a
per-user process/fd limit long before they show up as RAM, which is the same
failure mode the comment at `ssh/mod.rs:486-498` already documents.

## Fixed

**One change closed L-001, L-002 and L-006**, which were a single root cause
wearing three hats. The pty waiter thread — which already blocks on
`child.wait()` and therefore knows exactly when a shell dies — now calls
`pty::deregister` (`pty/mod.rs`) to drop the session from the map itself,
instead of waiting for a `pty_close` the frontend never sends. Downstream:
the map entry and its master fd are reclaimed (L-001); the cwd poller's `Weak`
stops upgrading so the thread exits within 1.5s (L-002); and with no poller
there is nothing left calling `SshRegistry::connection()` to resurrect a host
you disconnected (L-006). This mirrors `lsp.rs:248-266`, where the exit watcher
is likewise authoritative.

**L-005 / L-008** — added the missing `wait()` after `kill()` in
`AgentHandle::reap` and on the two `lsp_spawn` early-return paths.

**L-014** — added a builder-level `on_window_event` that reaps a window's
sessions on `Destroyed`. This one is independent of the others: it stranded
*live* shells, not dead ones, so no amount of exit-driven cleanup would have
caught it.

**L-013** — capped the debuggee partial-line buffer at 1 MiB
(`traceEvents.ts`). Over the ceiling, program output spills to console rather
than being dropped; an over-long tracer line is discarded, matching `flush()`.
Covered by `traceEvents.test.ts` (4 cases).

Verified: `cargo check` clean, `cargo test --lib` 145/145 pass, `vitest` 297/297
pass (excluding three `*.integration.test.ts` Codex suites that make live
`fetch` calls and fail without credentials — unrelated and pre-existing), clippy
clean on changed lines. Runtime confirmation of the pty fixes is via two new log
lines: `pty deregistered id=N after child exit` and
`window N closed: reaped N session(s)`.

## Still open — each needs a decision, not just effort

- **L-003** — the fix is to bound `reader_thread.join()` the way Windows already
  does, but the unconditional join is deliberate: it guarantees the last line of
  output never races the Exit event. Trading that for a timeout is a real
  tradeoff and should be a conscious choice.
- **L-007** — needs a number. Lowering `MAX_FRAME_BYTES` risks rejecting a
  legitimately large completion/variables response; reading incrementally
  instead avoids the pre-allocation but is more code. Pick one.
- **L-011** — an estimate, not a measurement, and not a leak. Measure RSS first;
  if it looks fine, close this as wontfix.

## Findings

### L-014 — HIGH — Closing a secondary window strands its terminals, shells still running
`src-tauri/src/lib.rs:316` (only window hook, settings-only) · `src-tauri/src/modules/pty/mod.rs` (`pty_close_all`) · `src/main.tsx:20`
Nothing reaped a window's sessions when it closed. The single `on_window_event` handler only closed the settings window, and `pty_close_all` runs at frontend *boot* scoped to the booting window's own label — so with `WINDOW_COUNTER` never reissuing a label (`lib.rs:22`), a closed window's entries were unreachable by any later call. Every terminal in that window kept a **live shell process**, its master fd, and its reader/waiter threads for the rest of the app's life. Strictly worse than L-001, which only stranded an fd for an already-dead shell.
Fixed by a builder-level `on_window_event` reaping on `Destroyed` via `pty::close_for_window`, sharing the extracted `reap_window` helper with `pty_close_all`.
*Status: fixed*

### L-001 — HIGH — PTY sessions are never removed from the map when a shell exits on its own
`src-tauri/src/modules/pty/mod.rs:30` (map), `:206` (only removal site) · `src/modules/terminal/lib/useTerminalSession.ts:273`
`pty_close` is the sole path that removes a `SessionEntry`, but the frontend sets `s.pty = null` inside `onExit` before any close path runs, so `s.pty?.close()` at `useTerminalSession.ts:433,608` is a no-op and the command never fires. Leaks one `SessionEntry` + one master pty fd per terminal whose shell exits normally. Inherited from upstream, not introduced by the fork.
*Status: fixed*

### L-002 — MED — Dropped SSH connections leak a live poller thread per pane
`src/modules/terminal/lib/useTerminalSession.ts:283-292` · `src-tauri/src/modules/pty/mod.rs:103`
Your SSH-reconnect path returns early to keep the pane and scrollback alive, so the Rust session stays in the map; `spawn_ssh_cwd_poller`'s `Weak` therefore still upgrades and the thread keeps issuing an agent request every 1.5s forever. Compounds L-001: each VPN blip adds a permanent thread plus recurring SSH traffic.
*Status: fixed*

### L-003 — LOW — Reader/flusher/waiter threads can hang forever if a daemon inherits the pty slave fd
`src-tauri/src/modules/pty/session.rs:195` (read loop), `:311` (blocking join)
If a backgrounded process (`nohup … &`) holds the slave fd open, `reader.read()` never returns EOF after the shell dies; the waiter then blocks in `reader_thread.join()` and never sets `done`, so the flusher never exits either. Costs 3 threads + up to 4 MiB of `pending` per affected session. Unix path only — Windows uses a 50 ms deadline instead.
*Status: open*

### L-005 — MED — Remote agent processes are killed but never reaped, leaving a zombie each time
`src-tauri/src/modules/ssh/agent.rs:179` (`shutdown`), `:231` (`Drop`)
Both paths call `child.kill()` with no matching `wait()`, and `shared_child` 1.1.1 has no `Drop` impl of its own, so every agent respawn (network drop, host reboot, version mismatch, disconnect) leaves a zombie `ssh` process that survives until Terax exits. Costs a process-table slot rather than heap, but it is unbounded and the same class of exhaustion the `ensure_reachable` comment at `ssh/mod.rs:486-498` was written to prevent.
*Status: fixed*

### L-006 — MED — A leaked cwd poller silently resurrects SSH hosts you disconnected
`src-tauri/src/modules/pty/mod.rs:116` · `src-tauri/src/modules/ssh/mod.rs:57-90`, `:880`
`SshRegistry::connection()` reconnects on a map miss by design, and the L-002 poller calls it every 1.5s. So after `ssh_disconnect` removes the entry and kills the master, the next poller tick re-runs `connect_blocking` — re-establishing the master and respawning the agent. Disconnect does not stay disconnected while any leaked poller exists, and each cycle also feeds L-005. This is a correctness bug as much as a leak.
*Status: fixed*

### L-007 — LOW — A stalled LSP/DAP server can pin 128 MB and hang its reader thread
`src-tauri/src/modules/lsp.rs:115-122`
`read_frame` allocates `vec![0u8; len]` from the server's own `Content-Length` before reading any payload, capped only by `MAX_FRAME_BYTES` (128 MiB). A server that announces a huge frame and then stalls holds that allocation while `read_exact` blocks with no timeout. Needs a misbehaving server, so low — but the cap is generous for the debugpy/pyright traffic it actually carries.
*Status: open*

### L-008 — LOW — Two `lsp_spawn` early-return paths kill without reaping
`src-tauri/src/modules/lsp.rs:161`, `:166`
Missing stdout/stderr pipes call `child.kill()` and bail before the exit watcher (which is the thing that normally does `wait()`) is ever started, leaving a zombie. Same class as L-005 but on a rare path. Worth noting mainly because the happy path here is the correct pattern the SSH agent should copy.
*Status: fixed*

### L-009 — LOW — Dead SSE subscribers linger until the next notification
`src-tauri/src/modules/mcp.rs:378-399`
`serve_sse` pushes its sender into `shared.sse` and never removes it on exit; entries are pruned only by the `retain` in `mcp_notify` (`:198`). A client that connects and drops repeatedly with no debugger activity in between grows the vec. Small and self-correcting on the next notify — noted so the asymmetry isn't mistaken for a bug later.
*Status: wontfix*

### L-010 — LOW — MCP accept loop spawns an unbounded thread per connection
`src-tauri/src/modules/mcp.rs:211-222`
No cap on concurrent connection threads. Mitigated by binding to 127.0.0.1, requiring a bearer token, and a 15s read timeout, so it needs a local process deliberately opening sockets. Fine for single-user local use; would not be for a shared machine.
*Status: wontfix*

### L-011 — MED — Dormant-pane snapshots are capped per session but scale linearly with tab count
`src/modules/terminal/lib/rendererPool.ts:25`, `:564-581` · `src/modules/terminal/lib/useTerminalSession.ts:351`
Only `POOL_MAX_SIZE = 5` panes hold a live xterm; every other open pane holds a serialized ANSI snapshot string instead, capped at `min(5000, terminalScrollback)` lines. That cap is per pane, so aggregate cost grows with how many tabs you keep open — order 1-2 MB each for dense colored output (JS strings are UTF-16), so roughly 25-50 MB at 30 open tabs. Bounded and freed on rebind or dispose, so not a leak — but it is the largest single allocation class on the WebView side and the number to check first if RSS looks high. **Estimate, not measured** — worth confirming with a heap snapshot before acting.
*Status: open*

### L-012 — LOW — `projectMemoryCache` never evicts
`src/modules/ai/lib/transport.ts:11`
Keyed by workspace root with no cap and no TTL check on the stored `mtime`, so every distinct project opened in a session retains its memory-file content until reload. Small values, bounded by how many projects you touch — noted for completeness, not worth fixing on its own.
*Status: wontfix*

### L-013 — LOW — Unterminated debuggee output grows a partial-line buffer without bound
`src/modules/debugger/lib/traceEvents.ts:13`, `:19-22`
`partial` holds the trailing fragment after the last newline per category; a debuggee that writes a very long line with no newline (a progress bar, a giant single-line JSON dump) grows that string until a newline arrives. Only two keys, scoped to a live DAP session, so it self-clears — but there is no ceiling on a single line.
*Status: fixed*

### L-004 — INFO — 4 MiB output backpressure cap is per session, not global
`src-tauri/src/modules/pty/session.rs:36`
`MAX_PENDING` bounds each session's unflushed buffer at 4 MiB, so worst case is 4 MiB × live tabs. Deliberate and correctly bounded; noted only so the multiplier isn't a surprise. The buffer does shrink back — the flusher's `mem::take` replaces it with a zero-capacity `Vec`.
*Status: wontfix*
