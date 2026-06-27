# tmux Tabs — Feature Spec

Persistent terminal sessions backed by tmux. A **tmux tab** is a terminal that
runs inside a tmux session from birth. Closing the tab detaches (does not kill);
the session keeps running on its host. A list popover lets you reattach or kill
sessions, scoped to the host the current window is connected to.

This is **Option B**: normal tabs stay plain shells. Only tmux tabs persist.
There is no attempt to move an already-running shell into tmux (process
reparenting is not possible / not portable).

---

## User-facing behavior

### 1. Creating a tmux tab
- The `+` new-tab dropdown (already exists at `src/modules/tabs/TabBar.tsx:347–408`,
  with items `onNew` / `onNewPrivate` / `onNewEditor` / `onNewPreview` /
  `onNewGitGraph`) gains one more item: **New tmux Terminal**.
- Selecting it opens a terminal whose shell is launched as:
  ```
  tmux new-session -A -s terax-<id> -c <cwd>
  ```
  `-A` = attach if the session already exists, else create. So the same menu
  item also acts as "create".
- The tab shows a small **tmux badge/icon** so it is visually distinct from a
  plain terminal — this signals "closing this won't kill it."
- On an **SSH window**, the tmux option targets the **remote host's** tmux (the
  `tmux new-session` runs on the remote, inside the existing `ssh -t` bootstrap).
  On a **local window**, it targets local tmux.

### 2. Closing a tmux tab → detach, not kill
- Closing a tmux tab must **not** run `kill-session`. It simply tears down the
  client PTY. tmux's default behavior on client SIGHUP is to keep the server
  session alive — so the shell and everything running in it survive.
- Everywhere else (plain tabs) close behavior is unchanged (PTY is killed).
- The close path therefore needs a branch keyed on "is this a tmux tab".

### 3. The tmux list popover
- A small **button** (header or status bar) opens a popover listing the current
  host's `terax-*` tmux sessions.
- Source of truth is `tmux ls` — nothing is persisted to disk. Reopening terax
  or reconnecting SSH and opening the list just shows whatever survived.
- Each row shows human-readable info (see Decision A below), with two actions:
  - **Attach** → opens a new tab running `tmux attach -d -t <name>`.
  - **Kill** → `tmux kill-session -t <name>` (this is the only way to kill a
    persisted session — "kill through the list").

---

## Decision A — Identity / what the list shows

Raw `terax-<id>` is not scannable. Render each row from tmux format strings:

```
tmux ls -F '#{session_name}\t#{session_path}\t#{pane_current_command}\t#{session_windows}\t#{session_created}'
```

- `session_name`   → stable id (`terax-<id>`), used for attach/kill.
- `session_path`   → current working directory (display).
- `pane_current_command` → what's running (e.g. `vim`, `node`, `zsh`).
- `session_windows` → window count.
- `session_created` → for an age / "created N ago" column.

Optional: allow **renaming** a session (`tmux rename-session`) so the list shows
a friendly label instead of the numeric id. The `terax-` prefix stays as the
filter key regardless of display name.

## Decision B — Host scoping

tmux lives per-host. The list is **context-aware**:
- **Local window** → runs `tmux ls / attach / kill / new-session` locally.
- **SSH window** → runs the same tmux commands **on the remote**, over the
  existing ssh control connection (ControlMaster is already set up in
  `ssh/mod.rs`, base args at `ssh/mod.rs:160`, `ssh_command()` at `ssh/mod.rs:188`).

So a thin command layer takes a "where" (local vs ssh-host) and dispatches the
tmux subcommand to the right place. The list popover queries whichever host the
active window is connected to.

---

## Architecture / where things hook in

### Backend (Rust)
- **Shell launch** — `src-tauri/src/modules/pty/shell_init.rs`. The local builder
  and the SSH base64 bootstrap (`shell_init.rs:82+`) both end in `exec {SHELL}`.
  For a tmux tab, wrap that as `exec tmux new-session -A -s terax-<id> -c <cwd>`.
  A flag/param on `pty_open` (`pty/mod.rs:47`) carries "this is a tmux tab" down
  to `session::spawn()` (`pty/session.rs:109`).
- **tmux control command** — a new thin module exposing Tauri commands:
  - `tmux_list(where)` → parsed rows (Decision A format).
  - `tmux_kill(where, name)`.
  - `tmux_available(where)` → `command -v tmux` probe (gates the menu item).
  - (attach/new are done via the normal pty launch path, not a separate command.)
  For `where = ssh-host`, reuse `ssh_command()` / `base_args()` to run the tmux
  subcommand over the multiplexed connection. For SSH, slot the `tmux_available`
  probe alongside the existing python3 probe in `connect_blocking()`
  (`ssh/mod.rs:430`).

### Frontend (TS/React)
- **`+` dropdown** — add `onNewTmux` item in `TabBar.tsx` (mirror `onNewPrivate`).
  Hide / disable the item when `tmux_available` is false for the current host
  (locally, optionally offer a one-line `brew install tmux` hint).
- **Tab model** — `src/modules/tabs/lib/useTabs.ts` (`TerminalTab` type): add a
  `tmux?: { name: string }` marker so the close path and the badge can branch.
- **Close path** — wherever terminal tabs are closed, branch: tmux tab → just
  unbind/close the PTY client (no kill); plain tab → existing behavior.
- **Launch path** — `src/modules/terminal/lib/useTerminalSession.ts` /
  `pty-bridge.ts` (`openPty()`): pass the tmux flag + session name through to
  `pty_open`.
- **List popover** — new small component + a button in the header or status bar
  (`src/modules/statusbar/` or `src/modules/header/Header.tsx`). Calls
  `tmux_list` for the active window's host; Attach opens a tab via the same
  tmux-launch path with `attach -d -t <name>`; Kill calls `tmux_kill`.
- **Badge** — small tmux icon on tmux tabs in `TabBar.tsx`.

---

## Known seams (acceptable, same as iTerm2)
- **Scrollback** on attach comes from tmux's `capture-pane` history, not terax's
  rendered xterm scrollback.
- **cwd tracking** under tmux: prefer `#{pane_current_path}` over the existing
  `.pid` + `/proc` poll for tmux tabs.
- **Resize**: a tmux session has one size shared by attached clients. Use
  `attach -d` (detach others) so terax drives geometry; consider
  `setw -g aggressive-resize on`.
- **tmux must exist on the host.** Common on Linux SSH boxes; not default on
  macOS. The menu item and list are gated on the `tmux_available` probe; absent
  tmux just hides the feature rather than erroring.

---

## Out of scope (possible later)
- tmux **control mode (`-CC`)** — mapping tmux windows/panes to native terax
  tabs/splits (the deep iTerm2-style fusion). This spec is the simpler
  named-session model and delivers the requested UX in full.
- Auto-surfacing the list after an SSH reconnect (nice-to-have; the list already
  shows survivors on demand).
