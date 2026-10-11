# Agent Orchestration — Handoff

> Research session 2026-10-07. **No code written yet.** This file is the full context for starting the build in a fresh session.
> Read this, then `.wolf/STATUS.md` (🚀 Next phase mirrors the plan below).

---

## 1. What the user wants

- **Orchestration + message passing between coding agents**, with **visibility** into which agent is doing what.
- **Agents are opencode and Claude Code CLIs.** The user does **not** use Terax's in-app AI chat — don't build orchestration around it (`src/modules/ai/tools/agent.ts` managed-agent tools are irrelevant).
- **Orchestrator = a real CLI agent** (Claude or opencode) running in a dedicated Terax panel (floating / docked / pinned tab — undecided). Terax's role: host the orchestrator + show the fleet.
- Must work **with and without Terax** running.
- Must work over **Terax's SSH module**:
  - **genie65** — Linux, 128 cores, **tcsh login shell**, no root, **NFS `$HOME` shared with SGE cluster nodes, 97% full (~1.8 GB free)**, Claude Code 2.1.292, opencode v2.0.22.
  - **winbox** — Windows, PowerShell 5.1, over Tailscale, `claude.exe` installed, no node; Python presence unconfirmed.
- Must work on **Windows** (Terax running on Windows, and Windows as SSH remote).
- **User's existing fleet style** (genie65): one git worktree + branch per agent, coordination via shared files (`results.tsv`, `agent_diary.py`, per-worktree `AGENT_LOG.md`), headless `nohup claude -p` loops with `.pid` + log files. The real gap is **visibility + re-attachability** (you can't type into a nohup log), not coordination.

---

## 2. Terax today (facts from the code)

| Area | How it works | Files |
|---|---|---|
| Agent status detection | Parses raw PTY output for OSC 133 (shell preexec `133;C;<cmd>` arms on `claude`/`codex`/`opencode`; `133;D` disarms) and OSC 777 `notify;Terax;{working,attention,finished}`. Never from plain output. | `src-tauri/src/modules/pty/agent_detect.rs` |
| Claude hooks | Installer merges `UserPromptSubmit/Notification/Stop` hooks into `~/.claude/settings.json`. Hook = POSIX sh: `[ -n "$TERAX_TERMINAL" ] && printf '{"terminalSequence":"\u001b]777;notify;Terax;<event>\u0007"}'`. | `src-tauri/src/modules/agent.rs` |
| Frontend store | Per-pane (`leafId`) sessions + notifications. **No concept of a host-level agent.** | `src/modules/agents/store/agentStore.ts` |
| SSH terminals | Local PTY hosting `ssh -t` over ControlMaster; optional remote tmux (`terax-*` sessions). OSC flows through the local PTY, so detection works over SSH. | `src-tauri/src/modules/pty/shell_init.rs` (`ssh_remote::build`) |
| SSH remote hooks | POSIX remotes get Claude hooks installed on connect (python heredoc). **Windows remotes get none.** | `src-tauri/src/modules/ssh/mod.rs` (`remote_claude_hooks_script`, `install_posix_remote_files`, `install_windows_remote_files`) |
| SSH remote helper | `agent.py` (stdlib Python 3.6+) JSON-lines RPC over ssh; ops for fs, grep, pty cwd, tmux cwd; 2s non-recursive polling watcher pushes `fs_changed`. Windows-aware. | `src-tauri/src/modules/ssh/agent.py`, `ssh/agent.rs` |
| SSH helpers to reuse | `remote_shell_command` (base64 `| sh` wrapper, tcsh-safe), `windows_remote_command` (PowerShell `-EncodedCommand`), `ssh_forward_port` (`ssh -O forward` on the master), `ensure_reachable`, `drop_dead_master`. | `src-tauri/src/modules/ssh/mod.rs` |
| tmux | Lists / attaches / kills `terax-*` tmux sessions locally and over SSH. | `src-tauri/src/modules/tmux.rs`, `statusbar/TmuxSessionsPopover.tsx` |
| Existing MCP server | Rust, streamable HTTP, bearer token (`terax-debugger`). Extend this if an MCP is ever needed — don't add a second stack. | `src-tauri/src/modules/mcp.rs` |

### Windows gaps in today's detection
- Local Windows shells: pwsh → powershell 5.1 → cmd (never Git Bash). `profile.ps1` emits **no OSC 133;C**, so there's no preexec detection; agents only show up via a hook's OSC 777 self-arm, which always labels them "claude". cmd.exe has no integration.
- WSL: `TERAX_TERMINAL` not forwarded (no `WSLENV`); hooks installer only writes Windows `%USERPROFILE%\.claude`.
- bash everywhere emits bare `133;C` (no command line) → no preexec match.
- `match_agent` rejects `claude.exe` / `opencode.cmd` (suffix must be empty or `-…`).
- Windows SSH remote (`build_windows`): sets `TERAX_TERMINAL`, but no shell integration, no hooks, no tmux.
- Hook command breaks on Windows Claude without Git Bash (falls back to PowerShell). Fix: exec-form hook (`command`=abs python, `args`=[script, event]) or `"shell":"powershell"` variant.
- ConPTY OSC passthrough (local inbox conhost and remote sshd conhost) is **unverified** and depends on the Windows build. Terax ships no `conpty.dll`/`OpenConsole.exe`.

---

## 3. Claude Code native features (2.1.29x) — build on these

Verified in docs, and `claude agents --json` checked live locally (2.1.292).

- **`claude agents --json [--all]`** lists active sessions (interactive + background) as JSON: `pid, cwd, kind, startedAt, sessionId, name, status` (+ `state`, `waitingFor` e.g. `"permission prompt"` for background). No TTY needed. `--all` adds completed background sessions; `--cwd <path>` filters.
- **`claude --bg --name X "<task>"`**, `claude attach <id>`, `claude logs <id>`, `claude stop <id>` — supervisor-managed background sessions. `--bg` rejects `-p`. It skips worktree creation when already inside a linked worktree (fits the user's layout). The supervisor stops idle processes after about 1h; state persists and resumes.
- **Cross-session messaging**: `ListAgents` / `SendMessage` tools. Same machine only (unix sockets; **named pipes on native Windows**). Needs ≥2.1.224 on mac/Linux and ≥2.1.234 on Windows. Cross-machine only via Remote Control (Anthropic servers). WSL2 ↔ native-Windows sessions can't reach each other. Messages are delivered between tool calls, marked "from another session", can't approve prompts or run slash commands, and are throttled (dedupe, queue cap 50). `claude -p` sessions bind an inbox too. Socket wire format is undocumented — Terax must not post to it directly.
  - **Gotcha:** unattended workers need `--settings '{"crossSessionInbound":"accept"}'`, otherwise messages from a non-bypass sender are held and, under `-p`, expire after 5 min.
- **Hooks**:
  - `terminalSequence` output (our OSC 777) is **ignored under `-p`**, so headless workers are invisible to the OSC detector.
  - Stop hook `{"decision":"block","reason"}` exists; `stop_hook_active` is a Stop/SubagentStop input field; 8-continuation cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).
  - `SubagentStop` exists. `async` + `asyncRewake` exist (wakes Claude on exit code 2; no re-arm, no timeout).
  - On Windows, hooks run in Git Bash if installed, else PowerShell; there's a `shell` field and an exec form (`args`).
- **MCP channels**: an MCP server can push into a running session, **but** custom channels need `--dangerously-load-development-channels` plus a confirmation dialog, are ignored under `-p`, and are a research preview (not on Bedrock/Vertex) → **not usable for unattended workers**.

---

## 4. opencode v2 (2.0.22) — researched from source at tag v2.0.22

**v2 is a breaking rewrite.** Everything under opencode.ai/docs (v1) is wrong for v2: no `/session/status`, `prompt_async`, `/tui/*`, `opencode attach`, port 4096. Use **opencode.ai/v2/docs** and SDK **`@opencode/client`** (not `@opencode-ai/sdk`). Source: github.com/anomalyco/opencode.

- **Process model**: one shared background service per user (`opencode serve --service`, detached), TCP **`127.0.0.1:49374`**, always-on auth (HTTP Basic `opencode:<password>`). All clients (TUI, `mini`, `run`, `api`) discover-or-start it. `--standalone` / `--server <url>` override.
- **Discovery**: `~/.local/state/opencode/service.json` → `{id, version, url, pid, password}` (same path under `%USERPROFILE%` on Windows). `opencode service status` prints URL or `stopped` and never spawns. **Don't use `opencode api` for discovery**: it can spawn a service and truncates piped output (#52925).
- **List / status**:
  - `GET /api/session?parentID=null&order=desc&limit=…&cursor=…` → `Session.Info` (`id, title, agent, model, cost, tokens, outcome, time{created,updated,idle,viewed}, location{directory}, permissions`).
  - `GET /api/session/active` → running sessions (only in this server process).
  - `GET /api/session/{id}/permission`, `GET /api/session/{id}/form` → pending approvals / questions.
  - `GET /api/info`.
- **Live events**: SSE `GET /api/event` (15s heartbeat, **no replay** → re-seed on reconnect). Events: `session.execution.started|succeeded|failed|interrupted`, `permission.asked|replied`, `form.created|replied|cancelled`, `session.retry.scheduled`, `session.updated|renamed|usage.updated`.
- **Send work**:
  - Create: `POST /api/session {location:{directory}, title, agent, model, permissions, id?}` — always pass `location.directory`, since the service's cwd is `$HOME`.
  - Prompt: `POST /api/session/{id}/prompt {text, delivery:"queue"|"steer"}` (default steer = inject mid-turn).
  - Approve: `POST /api/session/{id}/permission/{perID}/reply {decision:"once"|"always"|"reject"}`.
  - Also `POST /api/session/{id}/interrupt` and `opencode run -s <id> --auto`.
- **Attach**: `opencode -s <sessionID>` (Windows: `opencode mini -s <id>`; full TUI exits immediately on native Windows, #50845). Sessions run in the server with no TUI attached.
- **Unattended**: `--auto` (alias `--yolo`/`--dangerously-skip-permissions`), or a session permission rule `{"action":"*","resource":"*","effect":"allow"}`. `opencode run` without `--auto` auto-rejects permissions.
- **No peer-to-peer messaging** between sessions (only `subagent` tool, depth 1). MCP supported (`mcp.servers.<name>` local/remote).
- **Terminal notifications**: `~/.config/opencode/cli.json` `attention.notifications:true` (off by default; fires only when the terminal is blurred); force with `OPENTUI_NOTIFICATION_PROTOCOL=osc777`.
- **Gotchas**:
  - Pin `"shell":"/bin/bash"` on genie65 (tcsh).
  - Per-user `opencode service set port` on shared hosts (#50672).
  - A newer client **replaces** the running service → disable auto-update during runs.
  - The server interrupts executions after **60 min with no session events**.
- **Windows**: service startup over SSH flaky (#49034, #41746), MCP not loaded by the service (#50710), JSON quoting breaks `opencode api` on PS 5.1 (#51199), forward-slash MCP paths fail (#52771). WSL may be the practical route.
- **API stability**: big breaking audit v2.0.0→v2.0.10; paths stable 2.0.10→2.0.24 (additive). `/api/experimental/*` is outside the contract. Pin to `/api/info` version.

---

## 5. Rejected: plan v1 (don't rebuild it)

v1 was a custom file bus (`~/.terax/bus/` inboxes) + a Python stdlib MCP server (`send/read_inbox/spawn_agent`) + delivery via MCP channels / asyncRewake / Stop-hook block + a Terax cross-host relay. An adversarial review killed it:
- It duplicates native Claude features (`agents --json`, `--bg/attach`, `SendMessage`) with worse semantics.
- **Channels** aren't usable for workers (see §3).
- **Stop-hook `reason`** gives peer text hook-level authority, which makes prompt injection between agents easier.
- A **`spawn_agent` MCP tool** is a remote-code-execution primitive that bypasses the orchestrator's permission rules; agents could spawn agents on genie65/winbox.
- **File bus on genie65**: `$HOME` is NFS shared across SGE nodes (host-local pids collide, readdir caching delays), and the quota is 97% full.
- **On Windows**: `os.replace` fails while a reader has the file open; appends aren't atomic; **`os.kill(pid, 0)` terminates the process**.
- The cross-host relay only works while Terax runs → messages are silently stranded otherwise.

---

## 6. Plan v2 (current)

**Principle:** Terax adds a **multi-host view + attach**. Coordination uses each tool's native mechanism. The orchestrator lives **on the same host as its workers**.

### Roles
- **Claude workers**: `claude --bg --name agent-X --settings '{"crossSessionInbound":"accept"}' "<task/loop prompt>"`, run inside the agent's worktree. Replaces nohup + pid. Keep `results.tsv` and the diary as the ledger.
- **opencode workers**: sessions on the host's shared service, created and prompted via `/api/session…`.
- **Orchestrator**: plain `claude` or `opencode` in a Terax pane (local, or an SSH pane on the workers' host).
  - It spawns via its own Bash (`claude --bg …`), so its permission rules still apply.
  - Claude orchestrator: native `SendMessage` to Claude workers; HTTP (curl) to opencode workers.
  - opencode orchestrator: HTTP to opencode workers; can only *spawn* Claude workers with a task, not message them later. **This is the one gap.** If needed, a small tool would be justified here (extend `mcp.rs`, don't add a Python server).

### Terax Fleet board (the only new code)
- **Claude source**: Rust `fleet_list(workspace)` (async + spawn_blocking) runs `claude agents --json --all` in one of three ways:
  - locally;
  - over POSIX SSH via `remote_shell_command` with an absolute path (`~/.local/bin/claude`; tcsh PATH lacks it);
  - over Windows SSH via `windows_remote_command` (`claude.exe agents --json --all`).
  - Poll every 5–10s **only while the board is visible**; back off on SSH failure.
- **opencode source**: read `service.json` over SSH → `ssh_forward_port` to `49374` → HTTP seed (`/api/session`, `/active`, `/permission`, `/form`) + SSE `/api/event` per host. Push-based.
- **UI rows**: host, name/title, cwd/worktree, status, `waitingFor` (highlight "permission prompt" / pending opencode permission), cost/tokens for opencode.
- **Actions**:
  - Click → new Terax tab on that host running `claude attach <id>` or `opencode -s <id>` (`mini` on Windows).
  - Logs (`claude logs`).
  - Stop (`claude stop` / `/interrupt`), behind a confirmation.
- The existing OSC detector stays as a fast-path hint for open panes. The tmux popover covers other tmux workers.

### Without Terax
`claude agents/attach/logs/stop`, `SendMessage`, `opencode -s`, and the opencode HTTP API all work unchanged. Terax only adds the cross-host view. **Cross-host messaging: not supported** (native Remote Control if ever needed).

---

## 7. Milestones

- **M0 — verify (no code; touches genie65/winbox → ask the user first)**
  1. Do `nohup claude -p` loops appear in `claude agents --json`? (Expected: no → migrate the loop to `--bg`.)
  2. winbox: Claude ≥ 2.1.234? Does `claude.exe agents --json` work via Terax's PowerShell path? Does the `--bg` supervisor survive SSH disconnect (Win32-OpenSSH job-object kill)? Is Python present? (Without it, Terax can't connect at all.)
  3. Do bypass-mode workers actually receive orchestrator messages with `crossSessionInbound: accept`?
  4. opencode service: survives SSH logout (logind `KillUserProcesses`, Windows job object)? Does the Windows service start over SSH? Port 49374 collisions on genie65? Does the 60-min inactivity interrupt hit long silent tool calls? Does the tcsh `shell` pin work?
  5. Does OSC 777 survive remote tmux (no `allow-passthrough` handling in the repo)?
- **M1 — Fleet board, Claude source**: `fleet.rs` + `FleetBoard.tsx` + attach/logs/stop.
- **M2 — Fleet board, opencode source**: `fleet_opencode.rs` (service.json, port forward, HTTP + SSE).
- **M3 — Orchestrator panel**: pane preset (floating/docked/pinned) that launches claude/opencode on a chosen host with the fleet context.
- **M4 — Windows detection polish**:
  - Exec-form/PowerShell Claude hooks + Windows remote hook installer.
  - `profile.ps1` emits `133;C;<cmd>`.
  - `match_agent` strips `.exe/.cmd/.ps1`; self-arm carries the agent kind.
  - `WSLENV=TERAX_TERMINAL/u`.
- **M5 (only if needed)**: opencode-orchestrator → Claude-worker messaging tool via `mcp.rs`.

### Files (planned)
| Type | File | Content |
|---|---|---|
| new | `src-tauri/src/modules/fleet.rs` | `fleet_list` for Claude across local/POSIX/Windows hosts |
| new | `src-tauri/src/modules/fleet_opencode.rs` | opencode discovery, forward, HTTP seed, SSE |
| new | `src/modules/agents/components/FleetBoard.tsx` | board UI + actions |
| edit | `src/modules/agents/store/agentStore.ts` (or new `fleetStore.ts`) | host-level fleet entries |
| later | `pty/agent_detect.rs`, `ssh/mod.rs`, `pty/scripts/profile.ps1`, `modules/agent.rs` | Windows polish (M4) |

---

## 8. Open decisions (ask the user)

1. Orchestrator panel form: **floating overlay**, **docked side panel**, or **pinned tab**?
2. Orchestrator agent: **Claude, opencode, or both**? (opencode → Claude messaging is the one gap.)
3. OK to migrate the genie65 `nohup claude -p` loop to `claude --bg --name agent-X`?
4. Fleet mix: mostly Claude, or real Claude + opencode mix? (Sets M1 vs M2 priority.)
5. Permission to run the M0 checks on genie65 and winbox.

## 9. Hard rules carried over (from cerebrum Do-Not-Repeat)
- New Tauri commands doing remote I/O must be **async + spawn_blocking** (sync ones froze the UI).
- Don't spawn streaming stdio over SSH with the `echo B64|base64 -d|sh` wrapper (stdin = base64 pipe). Use `remote_stream_command`.
- genie65 login shell is **tcsh**: no `$(...)`, `2>&1`, or `2>/dev/null` in raw remote commands; wrap in `sh -c '…'` or use `remote_shell_command`, and use absolute binary paths.
- winbox shell is PowerShell 5.1: no `&&`.
