# Orchestrator & Fleet — usage guide

Terax does not run an orchestrator itself. It launches a normal Claude Code
session named `orchestrator` as a background job (`claude --bg`) on the
current workspace host, and gives you two views of it plus every other Claude
session on that host.

## 1. Starting one

1. Pick the workspace first (Local / SSH host / WSL in the status bar). The
   orchestrator lives on **that host**; switching hosts shows a different fleet.
2. Press **⌘I** (or the *Orchestrator* status-bar button).
3. Choose a directory and press **Start orchestrator**.

The directory you pick matters:

| It decides… | Why |
| --- | --- |
| trust | `claude --bg` refuses untrusted dirs. Open `claude` there once and accept the prompt if you have never used that dir. |
| the default cwd for workers | the orchestrator spawns from its own shell, so relative paths resolve there |
| where the transcript lands | `~/.claude/projects/<slug>/<sessionId>.jsonl`, which is what the Fleet tab's transcript pane reads |

**Rule of thumb:** start it in the *smallest directory that contains everything
it should touch*. One repo → that repo. Several repos → their common parent
(e.g. `~/Documents/coding`).

## 2. The two views

| | Floating window (⌘I) | Fleet tab (⤢ in the window header) |
| --- | --- | --- |
| orchestrator terminal | yes | yes (right pane) |
| agent list | compact strip | full list, click a row to select |
| transcripts | no | last 256 KB of the selected agent, live-polled |
| when to use | quick instructions, glance at who is busy | reviewing what a worker actually did, token stats, stuck agents |

Both views just `claude attach` to the same session, so closing either one
does **not** stop anything. Attention states in the list:

- **working** – busy
- **waiting** – blocked on a permission / question → attach and answer it
- **done** – finished since you last looked (cleared when you select the row)
- **idle** – alive, nothing to do

Rows marked **bg** can be attached/stopped from Terax. Rows marked **tty** are
interactive sessions in someone's terminal (including your own Claude Code
tabs) and are view-only.

## 3. Lifecycle

- The session is a real OS process. Quitting Terax, closing the window, or
  disconnecting SSH leaves it running.
- ⌘I on a host that already has an `orchestrator` job offers **Attach**, not
  Start. Only one orchestrator per host.
- **Stop** (window header or Fleet tab) runs `claude stop`. The conversation is
  kept: `claude attach <id>` (the short id shown in `claude agents`) reopens
  it, and `claude --resume` works.
- **Resuming a lost session**: the Fleet tab remembers every session it has
  listed. One that vanished (tab closed, worker stopped or removed) moves to
  **Recent / gone**, with its full session id (click to copy). **Resume in
  background** runs `claude --bg --resume <sessionId> --name <name>` from its
  cwd; if the session is still running the CLI starts a copy and says so. The
  orchestrator knows the same command.
- From any shell on the host: `claude agents` to list, `claude attach <id>`
  to join, **Ctrl+Z** inside the attached view to drop back to the shell
  without stopping it.

## 4. Good uses

1. **Parallel independent tasks** – "spawn three workers, one per module, each
   in its own worktree, and report when all are green." The prompt already
   tells it to use one worktree per agent.
2. **Long jobs on a compute box** – switch Terax to the SSH host, start the
   orchestrator there, close your laptop. Reconnect later and press ⌘I → Attach.
3. **Review fan-out** – have it start reviewers on each open PR and collect
   verdicts into a single file.
4. **Babysitting** – ask it to watch its workers via `claude agents --json`,
   unblock trivial permission prompts, and ping you (SendMessage) only when a
   worker is stuck or finished.

Workers are cheaper than the orchestrator: tell it to start them with
`--model sonnet` (or haiku for mechanical jobs) and keep the orchestrator
itself idle between check-ins. It is itself a full Claude session; every
message you send it costs tokens.

## 5. Working across repos

Nothing ties the orchestrator to one repo. It is a shell with `claude` in it,
so it can `cd` anywhere the host allows and run `claude --bg` there. Terax's
list shows every session on the host regardless of cwd (it runs
`claude agents --json --all`).

What you need for a multi-repo run:

- Each target repo must be **trusted** by Claude Code (see §1).
- Give it the absolute paths. A good first message:

  ```
  Repos: ~/Documents/coding/terax-terminal, ~/Documents/coding/protein_OPG.
  For each: create worktree agent/<task> off main, start a worker with
  claude --bg --name <repo>-<task> --model sonnet, task: "...".
  Check on them every few minutes with `claude agents --json`; when all are
  done, summarise the diffs in ~/fleet-report.md and message me.
  ```
- Name workers with a repo prefix so the Fleet list stays readable
  (`opg-scout`, `terax-lint`). Attach by the short id from `claude agents`:
  `claude attach <name>` also matches task text, so a bare name is ambiguous
  once a worker's task mentions it (e.g. `orchestrator`).

## 6. Remote hosts

1. Select the SSH host in the status bar, then ⌘I. The directory field is
   remote; *Browse…* is local-only, so type the path.
2. `claude` must be installed on the remote in a standard place
   (`~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`, Homebrew or
   `/usr/local/bin`). Terax resolves it even when the login shell is tcsh.
3. Hosts without a Bourne-style prompt marker (tcsh) get the launch command
   typed after output goes quiet for ~1.5 s. If you see the prompt but no
   command, press ⌘I → Attach once the listing shows the session.
4. Remote Control (`/rc` inside the attached session) binds to the session
   process, so you can steer it from claude.ai while the host stays up. Your
   Mac can be asleep if the orchestrator runs on another host; if it runs
   locally the Mac must stay awake.

## 7. Gotchas

- `claude -p` runs show up in the list but cannot be attached.
- A `--bg` job that sits idle for a long time may be stopped by Claude Code
  itself; `claude attach <id>` brings it back with its history.
- Windows (native, not WSL) workspaces are not supported yet.
- The transcript pane reads only the tail of the file; token totals there are
  for the visible part, not the whole run.
