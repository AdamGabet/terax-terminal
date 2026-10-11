# STATUS — terax

> Single source of truth for resuming work. Read this FIRST when starting a session.
> Update this file at the end of every work phase so the next `/clear` resumes in 1 read.
> Last updated: 2026-10-08

---

## ✅ Done
- [2026-10-07] Claude hooks: fixed invalid-JSON hook output (`printf %s`, all 3 events), startup migration of stale local hooks, Windows-SSH hook installer (`install_windows_claude_hooks`, Rust-side merge). Verified live on winbox (Git Bash runs hooks). Live test: `TERAX_SSH_WIN_TEST_HOST=winbox cargo test --lib ssh_live_windows_claude_hooks`.
- [2026-10-07] Fleet/orchestrator polish (uncommitted, tests pass, not yet tried in app): session id plain text + copy icon on selected row; transcript lookup falls back to `~/.claude/projects/*/<sid>.jsonl` (worktree sessions); attach-in-split fills 2x2 grid (`gridSplitTarget`); stopped sessions (`state: "stopped"`) dropped from live list → Recent/gone, orchestrator Stop works; notification bell Clear button (keeps forwarded ports). Not built: Interrupt button (no CLI support; would need hidden attach + Esc).

- [2026-10-08] Tab rename input closed immediately → ContextMenu `onCloseAutoFocus` preventDefault on Rename + early-blur refocus in `TabRenameInput` (not yet tried in app).
- [2026-10-08] opencode workers under the Claude orchestrator (uncommitted, not yet tried in app): prompt teaches `opencode run --auto -s ses_<agent> --title <agent> "<task>"` as a background Bash command (verified: custom `ses_` ids accepted, `-s` creates then continues, exits with reply). Board lists opencode v2 sessions (busy or updated <24h) via `fleet_list_opencode` (`fleet_opencode.rs`: service.json → reqwest locally, `curl -K -` over POSIX SSH, never spawns a service); `oc` badge, attach = `opencode -s <id>`, Stop = `POST /api/session/{id}/interrupt`; transcript view via `fleet_opencode_messages` (last 40 msgs → `parseOpencodeMessages`); busy sessions with a pending permission/form get `waitingFor` ("permission prompt (<action>)" / "question: <title>") → amber "needs you". Live test: `cargo test --lib live_remote_script -- --ignored --nocapture`.

- [2026-10-08] ⌘-click (Ctrl elsewhere) on a tab's close button closes it without the unsaved-changes / running-process prompts (`onClose(id, {force})` → `disposeTab`).

- [2026-10-08] Fleet Attach / Attach-in-split switch to an already-open pane that was opened with the same attach command (`findCommandLeaf` on leaf `restartCommand`) instead of opening another; split works for opencode rows too. Limit: a pane where the user quit the attach still matches (shell left behind).

- [2026-10-08] Permit button (amber, board + orchestrator strip) on attachable rows with `waitingFor`: disposes leaf 0 and reopens the floating terminal running the attach command with focus (`FloatingTerminalWindow` title/command/autoFocus props); plain floating shell is replaced only after the running-process check; permit window closes (dispose, no prompt) on X or when the fleet poll sees `waitingFor` cleared. Not tried in app.

<!-- Move items here from "🚀 Next phase" when finished. Group by area. -->

- (nothing yet — fill in as work completes)

---

## 🚀 Next phase

> **Full context: `orchestration_handoff.md` (repo root) — read it first.**

**Goal:** Agent orchestration v2 — a Terax **Fleet board** over Claude Code's native agent listing (+ opencode's server API), across local, POSIX-SSH and Windows-SSH hosts, with an orchestrator agent (claude/opencode) running in a Terax pane on the same host as its workers. (Plan v1 = custom file bus + Python MCP + channels — REJECTED after adversarial review 2026-10-07; full v1 in session scratchpad, not repo.)

### Acceptance criteria
1. Fleet board lists every Claude session on each connected host (local, genie65, winbox): name, host, cwd/worktree, state/status, `waitingFor` (highlight "permission prompt").
2. Click a row → new Terax tab on that host running `claude attach <id>`; also Logs (`claude logs`) and Stop (`claude stop`, confirm).
3. Board polls only while visible (5–10s), backs off on SSH failure; works over tcsh (genie65) and PowerShell 5.1 (winbox).
4. Orchestrator = normal claude/opencode in a Terax pane on the workers' host; spawns workers with its own Bash (`claude --bg --name agent-X --settings '{"crossSessionInbound":"accept"}' "<task>"`), messages them with native `SendMessage`. Works unchanged without Terax.

### opencode v2 integration (researched from v2.0.22 source, 2026-10-07)
- **NOT v1 API.** v2 routes are all `/api/*`; v1's `/session/status`, `prompt_async`, `/tui/*`, `opencode attach`, port 4096 do not exist. Docs: opencode.ai/v2/docs, SDK `@opencode/client`.
- **One shared service per user** (`opencode serve --service`, detached, TCP `127.0.0.1:49374`, Basic auth `opencode:<pw>`). Discovery = `~/.local/state/opencode/service.json` `{url,pid,password,version}` (Windows: same under `%USERPROFILE%`). Read the file over SSH — don't call `opencode api` (can spawn a service; truncates piped output #52925).
- **Transport:** SSH `-L` forward over the existing ControlMaster (reuse `ssh_forward_port`) → Terax talks HTTP/SSE directly. Avoids tcsh/PowerShell JSON quoting.
- **Board feed:** seed `GET /api/session?parentID=null&order=desc` + `GET /api/session/active` + `GET /api/session/{id}/permission|form`; live via SSE `GET /api/event` (`session.execution.started|succeeded|failed|interrupted`, `permission.asked|replied`, `form.created|replied|cancelled`). No replay → re-seed on reconnect. Push-based, unlike Claude (poll).
- **Attach:** `opencode -s <sessionID>` (Windows: `opencode mini -s <id>` — full TUI exits on native Windows #50845). Optional backup signal: `cli.json` `attention.notifications:true` + `OPENTUI_NOTIFICATION_PROTOCOL=osc777`.
- **Send work:** `POST /api/session {location:{directory},title,agent,model,permissions}`, `POST /api/session/{id}/prompt {text, delivery:"queue"|"steer"}`, approve `POST /api/session/{id}/permission/{per}/reply {decision}`, `POST /api/session/{id}/interrupt`.
- **No native peer messaging in opencode** (only subagents). An opencode orchestrator drives workers over this HTTP API; it cannot use Claude's `SendMessage` (socket wire format undocumented). Claude→opencode = HTTP; opencode→Claude = spawn `claude --bg` with the task only (gap).
- Host setup: pin `"shell":"/bin/bash"` on genie65 (tcsh); per-user `opencode service set port` on shared box (#50672); disable auto-update during runs (newer client replaces the service). Server interrupts executions after 60 min with no session events.

### M0 — verify before coding (no code)
- Do `claude -p` (nohup loop) sessions appear in `claude agents --json`? Expect no → migrate genie65 loop to `claude --bg`.
- winbox: claude ≥ 2.1.234? `claude.exe agents --json` via Terax's PowerShell path; does the `--bg` supervisor survive SSH disconnect (Win32-OpenSSH job-object kill)? Is Python present?
- Bypass-mode workers receive orchestrator messages with `crossSessionInbound: accept` (else held, dropped after 5 min).
- opencode v2: service survives SSH logout (logind / Win32-OpenSSH job object)? Windows service starts over SSH (#49034) and loads MCP (#50710)? port 49374 collisions on genie65? 60-min inactivity interrupt on long silent tools?
- Does OSC 777 survive remote tmux (no allow-passthrough handling in repo)?

### Files to create / edit
| Type | File | Content |
|---|---|---|
| new | `src-tauri/src/modules/fleet.rs` | `fleet_list(workspace)` async + spawn_blocking: local exec / `remote_shell_command` (abs paths `~/.local/bin/claude`) / `windows_remote_command` (`claude.exe agents --json --all`); optional opencode status merge |
| new | `src-tauri/src/modules/fleet_opencode.rs` | read service.json over SSH, `-L` forward, HTTP seed + SSE `/api/event` per host |
| new | `src/modules/agents/components/FleetBoard.tsx` | rows + attach/logs/stop actions |
| edit | `src/modules/agents/store/agentStore.ts` | host-level fleet entries (current store is per-leafId only) |
| later | `pty/agent_detect.rs` | `match_agent` strip `.exe/.cmd/.ps1`; don't default self-arm to "claude" |
| later | `pty/scripts/profile.ps1` | emit OSC 133;C with command line (PS has none today) |

### Closed decisions
- No custom bus / Python MCP server / channels / Stop-hook or asyncRewake delivery / spawn_agent MCP tool. Native `claude --bg|agents|attach|logs|stop` + `SendMessage` + opencode HTTP API cover it. Reasons: channels need `--dangerously-load-development-channels` + dialog and are ignored under `-p`; Stop-hook "reason" gives peer text hook-level authority (prompt-injection amplifier); spawn tool = RCE primitive bypassing permission rules; genie65 $HOME is NFS shared across SGE nodes and 97% full.
- Orchestrator lives on the same host as its workers (native messaging is same-machine only; cross-machine needs Remote Control).
- OSC detector stays as the fast-path hint for open panes; `claude agents --json` is the source of truth (OSC `terminalSequence` is ignored in `-p`).
- Windows: no tmux path. Claude workers via `claude --bg`; opencode on Windows is rough (resize crash, MCP path bugs) → prefer WSL or psmux if needed. WSL↔native-Windows Claude sessions cannot message each other.

### Open decisions
- Orchestrator panel form: floating overlay vs docked side panel vs pinned tab.
- Fleets mostly Claude, or mixed with opencode (decides priority of opencode status merge)?
- OK to migrate the genie65 nohup `claude -p` loop to `claude --bg --name agent-X`?

---

## 📁 Active architecture

- **Stack:** _<frameworks, libraries, runtime>_
- **Key tables / modules:** _<list>_
- **Patterns:** _<conventions enforced project-wide>_

---

## ⚠️ External blockers (don't block coding)

- _<env vars, secrets, external accounts, manual steps>_

---

## 🔧 Useful commands

```bash
# add the most-used commands here so the next session has them ready
```

---

## 📚 References (read IF needed)

- `.wolf/cerebrum.md` — User Preferences + Do-Not-Repeat + Decision Log
- `.wolf/anatomy.md` — token-efficient file index
- `.wolf/buglog.json` — known bugs + fixes
