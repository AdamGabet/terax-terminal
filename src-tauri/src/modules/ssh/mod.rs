pub mod agent;
pub mod fsops;

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct FsChangedPayload {
    paths: Vec<String>,
}

pub const AGENT_SCRIPT: &str = include_str!("agent.py");

// Shell-integration scripts shared with the local PTY spawn path.
const ZSHENV: &str = include_str!("../pty/scripts/zshenv.zsh");
const ZPROFILE: &str = include_str!("../pty/scripts/zprofile.zsh");
const ZLOGIN: &str = include_str!("../pty/scripts/zlogin.zsh");
const ZSHRC: &str = include_str!("../pty/scripts/zshrc.zsh");
const BASHRC: &str = include_str!("../pty/scripts/bashrc.bash");
const FISH_INIT: &str = include_str!("../pty/scripts/init.fish");

/// Remote locations, relative to $HOME on the host.
pub const REMOTE_AGENT_PATH: &str = ".cache/terax/remote/agent.py";
pub const REMOTE_ZDOTDIR: &str = ".cache/terax/shell-integration/zsh";
pub const REMOTE_BASH_RCFILE: &str = ".cache/terax/shell-integration/bash/bashrc";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemotePlatform {
    Posix,
    Windows,
}

static REGISTRY: OnceLock<SshRegistry> = OnceLock::new();

pub fn registry() -> &'static SshRegistry {
    REGISTRY.get_or_init(SshRegistry::default)
}

#[derive(Default)]
pub struct SshRegistry {
    conns: Mutex<HashMap<String, Arc<SshConnection>>>,
}

impl SshRegistry {
    /// Live connection for `host`, transparently reconnecting when the
    /// backend restarted while the window stayed on an SSH workspace (dev
    /// rebuilds, app relaunch). Callers run on blocking threads, so the
    /// connect handshake here can't stall the UI.
    pub fn connection(&self, host: &str) -> Result<Arc<SshConnection>, String> {
        if let Some(conn) = self
            .conns
            .lock()
            .expect("ssh registry poisoned")
            .get(host)
            .cloned()
        {
            return Ok(conn);
        }
        static RECONNECT_LOCK: Mutex<()> = Mutex::new(());
        let _serialize = RECONNECT_LOCK.lock().expect("ssh reconnect lock poisoned");
        // Another caller may have reconnected while we waited.
        if let Some(conn) = self
            .conns
            .lock()
            .expect("ssh registry poisoned")
            .get(host)
            .cloned()
        {
            return Ok(conn);
        }
        let app = crate::APP_HANDLE.get().cloned().ok_or_else(|| {
            format!("not connected to SSH host '{host}' — reconnect from the status bar")
        })?;
        connect_blocking(app, host.to_string())
            .map_err(|e| format!("SSH reconnect to {host} failed: {e}"))?;
        self.conns
            .lock()
            .expect("ssh registry poisoned")
            .get(host)
            .cloned()
            .ok_or_else(|| format!("not connected to SSH host '{host}'"))
    }

    fn insert(&self, conn: Arc<SshConnection>) {
        self.conns
            .lock()
            .expect("ssh registry poisoned")
            .insert(conn.host.clone(), conn);
    }

    fn remove(&self, host: &str) -> Option<Arc<SshConnection>> {
        self.conns
            .lock()
            .expect("ssh registry poisoned")
            .remove(host)
    }
}

pub struct SshConnection {
    pub host: String,
    pub home: String,
    pub login_shell: String,
    pub platform: RemotePlatform,
    python_command: String,
    python_args: Vec<String>,
    app: AppHandle,
    agent: Mutex<Option<Arc<agent::AgentHandle>>>,
}

impl SshConnection {
    /// Returns the live remote agent, respawning it if the previous one died
    /// (network drop, host reboot). The master connection auto-reestablishes.
    pub fn agent(&self) -> Result<Arc<agent::AgentHandle>, String> {
        let mut guard = self.agent.lock().expect("ssh agent slot poisoned");
        if let Some(a) = guard.as_ref() {
            if a.is_alive() {
                return Ok(a.clone());
            }
        }
        let app = self.app.clone();
        let handle = agent::AgentHandle::spawn(
            &self.host,
            self.platform,
            &self.home,
            &self.python_command,
            &self.python_args,
            move |paths| {
                let _ = app.emit("fs:changed", FsChangedPayload { paths });
            },
        )?;
        *guard = Some(handle.clone());
        Ok(handle)
    }

    fn shutdown(&self) {
        if let Some(a) = self.agent.lock().expect("ssh agent slot poisoned").take() {
            a.shutdown();
        }
    }
}

/// SSH destinations we accept: config aliases, hostnames, IPs, `user@host`.
/// Rejects anything that could be parsed as an ssh option (leading `-`) or
/// that could escape quoting downstream.
pub fn validate_host(host: &str) -> Result<(), String> {
    let ok = !host.is_empty()
        && host.len() <= 255
        && !host.starts_with('-')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '_' | '-' | ':'));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid SSH host: {host}"))
    }
}

fn control_dir() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".cache")
        .join("terax")
        .join("ssh");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Multiplexing options shared by every ssh invocation for a host. The first
/// call establishes a master that persists for 10 minutes after last use, so
/// follow-up execs skip the (potentially multi-hop) handshake.
pub fn base_args(interactive: bool) -> Vec<String> {
    let control = control_dir().join("cm-%C");
    let mut args = vec![
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        format!("ControlPath={}", control.to_string_lossy()),
        "-o".into(),
        "ControlPersist=600".into(),
        "-o".into(),
        "ConnectTimeout=20".into(),
        // Detect a silent drop (VPN/network blip) within ~9s (3s x 3 missed
        // probes) so the UI can flip to "disconnected" and auto-reconnect.
        "-o".into(),
        "ServerAliveInterval=3".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
    ];
    if !interactive {
        // Never hang a backend call on a password prompt.
        args.push("-o".into());
        args.push("BatchMode=yes".into());
    }
    args
}

/// `ssh <mux opts> <host>` with the host validated; caller appends the remote
/// command.
pub fn ssh_command(host: &str) -> Result<Command, String> {
    validate_host(host)?;
    let mut cmd = Command::new("ssh");
    cmd.args(base_args(false));
    cmd.arg(host);
    Ok(cmd)
}

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64_ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(B64_ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64_ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Token identifying one PTY's remote pid file. Process-id scoped so two Terax
/// instances can't collide on the same host.
pub fn pty_token(pty_id: u32) -> String {
    format!("{}-{}", std::process::id(), pty_id)
}

/// POSIX single-quote escaping.
pub fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    out.push_str(&s.replace('\'', r"'\''"));
    out.push('\'');
    out
}

/// PowerShell single-quoted string escaping.
pub fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub fn powershell_encoded_arg(script: &str) -> String {
    let utf16le: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    b64_encode(&utf16le)
}

pub(crate) fn windows_remote_command(
    host: &str,
    script: &str,
    interactive: bool,
) -> Result<Command, String> {
    let script = format!(
        "$utf8 = [Text.UTF8Encoding]::new($false)\n\
         [Console]::OutputEncoding = $utf8\n\
         $OutputEncoding = $utf8\n{script}"
    );
    let mut cmd = if interactive {
        validate_host(host)?;
        let mut cmd = Command::new("ssh");
        cmd.args(base_args(true));
        cmd.arg("-tt").arg(host);
        cmd
    } else {
        ssh_command(host)?
    };
    cmd.arg("--").arg(format!(
        "powershell.exe -NoLogo -NoProfile {}-EncodedCommand {}",
        if interactive {
            "-NoExit "
        } else {
            "-NonInteractive "
        },
        powershell_encoded_arg(&script)
    ));
    Ok(cmd)
}

fn connection_platform(host: &str) -> Result<RemotePlatform, String> {
    Ok(registry().connection(host)?.platform)
}

pub fn platform(host: &str) -> Result<RemotePlatform, String> {
    connection_platform(host)
}

/// Wraps an arbitrary POSIX script so it survives ANY remote login shell
/// (tcsh/csh users included): the top-level command sshd hands to the login
/// shell is plain `echo <base64> | base64 -d | sh`, which every shell parses
/// identically. Newlines, quotes, and unicode in `script` are all safe.
pub fn remote_script_arg(script: &str) -> String {
    format!("echo {} | base64 -d | sh", b64_encode(script.as_bytes()))
}

/// `ssh host -- <wrapped script>`: runs `script` under POSIX `sh` on the host.
pub fn remote_shell_command(host: &str, script: &str) -> Result<Command, String> {
    match connection_platform(host)? {
        RemotePlatform::Posix => {
            let mut cmd = ssh_command(host)?;
            cmd.arg("--");
            cmd.arg(remote_script_arg(script));
            Ok(cmd)
        }
        RemotePlatform::Windows => windows_remote_command(host, script, false),
    }
}

/// Like [`remote_script_arg`], but for a **streaming stdio server** (LSP / DAP)
/// that must read its protocol off the SSH channel's stdin. The plain wrapper
/// pipes the script *into* `sh` (`… | sh`), so `sh` — and anything it `exec`s —
/// inherits the base64 pipe as fd 0, which is already at EOF. A stdio language
/// server or debug adapter then sees an instant EOF and exits (debugpy: "No
/// more messages" → exit 1). Here the decoded script is written to a temp file
/// and run as `sh <file>`, a *separate* command whose fd 0 is the real SSH
/// stdin, so the server reads the client's messages. Still `$`-free at the
/// top level so csh/tcsh login shells parse it verbatim; the random name keeps
/// concurrent LSP+DAP spawns from colliding. `rm` runs after the server exits.
pub fn remote_stream_script_arg(script: &str) -> String {
    let f = format!("/tmp/terax-lsp-{}.sh", rand_hex());
    format!(
        "echo {} | base64 -d > {f} ; sh {f} ; rm -f {f}",
        b64_encode(script.as_bytes())
    )
}

/// Streaming counterpart of [`remote_shell_command`] — see
/// [`remote_stream_script_arg`] for why stdio servers need it.
pub fn remote_stream_command(host: &str, script: &str) -> Result<Command, String> {
    match connection_platform(host)? {
        RemotePlatform::Posix => {
            let mut cmd = ssh_command(host)?;
            cmd.arg("--");
            cmd.arg(remote_stream_script_arg(script));
            Ok(cmd)
        }
        RemotePlatform::Windows => windows_remote_command(host, script, false),
    }
}

/// Builds a remote process launch without passing program arguments through the
/// remote account's default shell parser. Used by git, LSP, and DAP.
pub fn remote_program_command(
    host: &str,
    program: &str,
    args: &[String],
    env: Option<&HashMap<String, String>>,
    cwd: Option<&str>,
    streaming: bool,
) -> Result<Command, String> {
    match connection_platform(host)? {
        RemotePlatform::Posix => {
            let mut script = String::new();
            if let Some(vars) = env {
                for (key, value) in vars {
                    script.push_str(&format!("export {key}={}\n", sh_quote(value)));
                }
            }
            if let Some(dir) = cwd.filter(|s| !s.is_empty()) {
                script.push_str(&format!("cd {} || exit 1\n", sh_quote(dir)));
            }
            script.push_str("exec ");
            script.push_str(&sh_quote(program));
            for arg in args {
                script.push(' ');
                script.push_str(&sh_quote(arg));
            }
            if streaming {
                remote_stream_command(host, &script)
            } else {
                remote_shell_command(host, &script)
            }
        }
        RemotePlatform::Windows => {
            let mut script = String::from("$ProgressPreference='SilentlyContinue'\n$ErrorActionPreference='Stop'\n");
            if let Some(vars) = env {
                for (key, value) in vars {
                    script.push_str(&format!("$env:{key} = {}\n", ps_quote(value)));
                }
            }
            if let Some(dir) = cwd.filter(|s| !s.is_empty()) {
                script.push_str(&format!("Set-Location -LiteralPath {}\n", ps_quote(dir)));
            }
            script.push_str("& ");
            script.push_str(&ps_quote(program));
            for arg in args {
                script.push(' ');
                script.push_str(&ps_quote(arg));
            }
            script.push_str("\nexit $LASTEXITCODE\n");
            windows_remote_command(host, &script, false)
        }
    }
}

pub fn remote_user_command(
    host: &str,
    command: &str,
    cwd: Option<&str>,
) -> Result<Command, String> {
    match connection_platform(host)? {
        RemotePlatform::Posix => {
            let mut script = String::new();
            if let Some(dir) = cwd.filter(|s| !s.is_empty()) {
                script.push_str(&format!("cd {} || exit 1\n", sh_quote(dir)));
            }
            script.push_str(command);
            remote_shell_command(host, &script)
        }
        RemotePlatform::Windows => {
            let mut script = String::new();
            if let Some(dir) = cwd.filter(|s| !s.is_empty()) {
                script.push_str(&format!("Set-Location -LiteralPath {}\n", ps_quote(dir)));
            }
            script.push_str(command);
            windows_remote_command(host, &script, false)
        }
    }
}

/// Short random hex for a unique remote temp path (no shell metacharacters).
fn rand_hex() -> String {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Runs a short remote script, capturing stdout. Errors carry stderr.
pub fn exec_capture(host: &str, script: &str) -> Result<String, String> {
    let mut cmd = remote_shell_command(host, script)?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("ssh spawn failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "ssh {host} failed (exit {:?}): {}",
            out.status.code(),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Waits for `child` up to `timeout`, killing and reaping it on overrun.
/// Returns the exit status, or `None` if it was killed (timeout) or errored.
fn wait_bounded(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

/// Fast liveness gate run BEFORE spawning an interactive `ssh -t` terminal
/// (e.g. opening a new tab after a screen lock). Reuses the multiplexing master
/// when healthy, so the common case is sub-second.
///
/// The failure mode this prevents: when the network drops out from under a live
/// SSH session (VPN disconnect, Wi-Fi roam), the master is left half-open. New
/// mux clients don't honor ConnectTimeout — they block on the dead master until
/// ServerAliveCountMax*Interval elapses (~minutes). Each blocked `ssh -t` holds
/// a local pty + process slot; enough of them pile up to exhaust the per-user
/// process table and `forkpty` starts failing with EAGAIN ("Resource
/// temporarily unavailable" / "Could not create a new process and open a
/// pseudo-tty"), which breaks EVERY terminal — local sessions included.
///
/// We enforce our OWN wall-clock timeout here, and on failure tear the dead
/// master down so it can't keep stalling future spawns.
pub fn ensure_reachable(host: &str) -> Result<(), String> {
    validate_host(host)?;
    const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

    // base_args(false) sets BatchMode=yes (never prompt) and reuses the master.
    let mut cmd = match connection_platform(host)? {
        RemotePlatform::Posix => {
            let mut cmd = ssh_command(host)?;
            cmd.arg("--").arg("true");
            cmd
        }
        RemotePlatform::Windows => windows_remote_command(host, "exit 0", false)?,
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::modules::proc::hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("ssh spawn failed: {e}"))?;
    match wait_bounded(&mut child, PROBE_TIMEOUT) {
        Some(status) if status.success() => Ok(()),
        Some(_) => {
            drop_dead_master(host);
            Err(format!(
                "SSH host '{host}' is unreachable — reconnect from the status bar"
            ))
        }
        None => {
            drop_dead_master(host);
            Err(format!(
                "SSH host '{host}' did not respond within {}s (VPN or network down?) — reconnect from the status bar",
                PROBE_TIMEOUT.as_secs()
            ))
        }
    }
}

/// Tears down a master that failed `ensure_reachable`: drops the registry entry
/// (and its agent), then asks the multiplexing master to exit so lingering
/// ControlPersist can't keep blocking later spawns. The `-O exit` is itself
/// time-bounded — a wedged master must not reintroduce the very hang we're
/// avoiding.
fn drop_dead_master(host: &str) {
    if let Some(conn) = registry().remove(host) {
        conn.shutdown();
    }
    if let Ok(mut cmd) = ssh_command(host) {
        cmd.arg("-O").arg("exit");
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::modules::proc::hide_console(&mut cmd);
        if let Ok(mut child) = cmd.spawn() {
            let _ = wait_bounded(&mut child, Duration::from_secs(3));
        }
    }
}

fn heredoc_section(path: &str, content: &str, idx: usize) -> String {
    // Quoted delimiter => verbatim heredoc; content is our own embedded
    // scripts, which never contain the delimiter line.
    let delim = format!("TERAX_EOF_{idx}");
    debug_assert!(!content.contains(&delim));
    format!(
        "cat > {p}.tmp <<'{delim}'\n{content}\n{delim}\nmv {p}.tmp {p}\n",
        p = sh_quote(path),
    )
}

fn remote_claude_hooks_script() -> &'static str {
    r#"python3 - <<'TERAX_CLAUDE_HOOKS'
import json
import os
import pathlib
import sys
import tempfile

events = [
    ("UserPromptSubmit", "working"),
    ("Notification", "attention"),
    ("Stop", "finished"),
]
owned_markers = ("notify;Terax;", "terax;notify")

def hook_cmd(event):
    return '[ -n "$TERAX_TERMINAL" ] && printf \'{"terminalSequence":"\\u001b]777;notify;Terax;%s\\u0007"}\' || true' % event

def is_ours(group):
    for hook in group.get("hooks") or []:
        command = hook.get("command")
        if isinstance(command, str) and any(marker in command for marker in owned_markers):
            return True
    return False

def is_empty_group(group):
    hooks = group.get("hooks")
    return not isinstance(hooks, list) or len(hooks) == 0

path = pathlib.Path.home() / ".claude" / "settings.json"
try:
    if path.exists() and path.read_text().strip():
        root = json.loads(path.read_text())
    else:
        root = {}
except Exception as exc:
    print(f"terax: skipping Claude hook install; {path} is not valid JSON: {exc}", file=sys.stderr)
    raise SystemExit(0)

if not isinstance(root, dict):
    root = {}
hooks = root.setdefault("hooks", {})
if not isinstance(hooks, dict):
    hooks = {}
    root["hooks"] = hooks

for event, marker in events:
    groups = hooks.setdefault(event, [])
    if not isinstance(groups, list):
        groups = []
    groups = [group for group in groups if not is_ours(group) and not is_empty_group(group)]
    groups.append({"hooks": [{"type": "command", "command": hook_cmd(marker)}]})
    hooks[event] = groups

path.parent.mkdir(parents=True, exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix="settings.json.", suffix=".terax-tmp", dir=str(path.parent))
with os.fdopen(fd, "w") as f:
    json.dump(root, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
TERAX_CLAUDE_HOOKS
"#
}

/// Uploads the remote agent + shell-integration scripts in a single ssh exec
/// (script streamed over stdin, like `ssh host sh`). Idempotent; runs on every
/// connect so the agent is always the version this build expects.
fn install_posix_remote_files(host: &str) -> Result<(), String> {
    let mut script = String::from(
        "set -e\n\
         mkdir -p \"$HOME/.cache/terax/remote\" \"$HOME/.cache/terax/shell-integration/zsh\" \
         \"$HOME/.cache/terax/shell-integration/bash\" \"$HOME/.config/fish/conf.d\"\n\
         rm -f \"$HOME/.cache/terax/remote\"/pty-*.pid \"$HOME/.cache/terax/remote\"/paste-*\n\
         cd \"$HOME\"\n",
    );
    let files: &[(&str, &str)] = &[
        (REMOTE_AGENT_PATH, AGENT_SCRIPT),
        (".cache/terax/shell-integration/zsh/.zshenv", ZSHENV),
        (".cache/terax/shell-integration/zsh/.zprofile", ZPROFILE),
        (".cache/terax/shell-integration/zsh/.zshrc", ZSHRC),
        (".cache/terax/shell-integration/zsh/.zlogin", ZLOGIN),
        (REMOTE_BASH_RCFILE, BASHRC),
        (".config/fish/conf.d/terax.fish", FISH_INIT),
    ];
    for (i, (path, content)) in files.iter().enumerate() {
        script.push_str(&heredoc_section(path, &content.replace("\r\n", "\n"), i));
    }
    script.push_str(remote_claude_hooks_script());
    script.push_str("echo TERAX_INSTALL_OK\n");

    let mut cmd = ssh_command(host)?;
    cmd.arg("--").arg("sh");
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("ssh spawn failed: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("no stdin pipe")?
        .write_all(script.as_bytes())
        .map_err(|e| format!("install stream failed: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("install wait failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() || !stdout.contains("TERAX_INSTALL_OK") {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "installing Terax remote helper on {host} failed: {}",
            stderr.trim()
        ));
    }
    Ok(())
}

fn install_windows_remote_files(host: &str, home: &str) -> Result<(), String> {
    let script = format!(
        "$ProgressPreference='SilentlyContinue'\n$ErrorActionPreference='Stop'\n\
         $dir = Join-Path {} '.cache\\terax\\remote'\n\
         New-Item -ItemType Directory -Force -Path $dir | Out-Null\n\
         Get-ChildItem -LiteralPath $dir -Filter 'paste-*' -File -ErrorAction SilentlyContinue | \
           Remove-Item -Force -ErrorAction SilentlyContinue\n\
         $path = Join-Path $dir 'agent.py'\n\
         $payload = [Console]::In.ReadToEnd()\n\
         [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($payload))\n\
         Write-Output 'TERAX_INSTALL_OK'",
        ps_quote(home)
    );
    let mut cmd = windows_remote_command(host, &script, false)?;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("ssh spawn failed: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("no stdin pipe")?
        .write_all(b64_encode(AGENT_SCRIPT.as_bytes()).as_bytes())
        .map_err(|e| format!("install stream failed: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("install wait failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() || !stdout.contains("TERAX_INSTALL_OK") {
        return Err(format!(
            "installing Terax remote helper on {host} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct SshConnectInfo {
    pub host: String,
    pub home: String,
    pub shell: String,
    pub platform: RemotePlatform,
}

struct RemoteProbe {
    platform: RemotePlatform,
    home: String,
    shell: String,
    python_command: String,
    python_args: Vec<String>,
}

fn capture_command(mut cmd: Command, stdin: Option<&[u8]>) -> Result<String, String> {
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("ssh spawn failed: {e}"))?;
    if let Some(data) = stdin {
        child
            .stdin
            .take()
            .ok_or("no stdin pipe")?
            .write_all(data)
            .map_err(|e| format!("ssh stdin failed: {e}"))?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn probe_posix(host: &str) -> Result<RemoteProbe, String> {
    let script = b"printf 'TERAX_POSIX\\n%s\\n%s\\n%s\\n' \"$HOME\" \"$SHELL\" \"$(command -v python3 || true)\"\n";
    let mut cmd = ssh_command(host)?;
    cmd.arg("--").arg("sh");
    let output = capture_command(cmd, Some(script))?;
    let mut lines = output.lines();
    if lines.next() != Some("TERAX_POSIX") {
        return Err("not a POSIX SSH account".into());
    }
    let home = lines.next().unwrap_or("").trim().to_string();
    let shell = lines.next().unwrap_or("").trim().to_string();
    let python = lines.next().unwrap_or("").trim().to_string();
    if home.is_empty() || python.is_empty() {
        return Err("POSIX remote requires HOME and python3".into());
    }
    Ok(RemoteProbe {
        platform: RemotePlatform::Posix,
        home,
        shell,
        python_command: python,
        python_args: Vec::new(),
    })
}

fn probe_windows(host: &str) -> Result<RemoteProbe, String> {
    let script = r#"$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
$python = $null
$pythonArgs = ''
foreach ($name in @('python.exe', 'python3.exe', 'py.exe')) {
  $candidate = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $candidate) { continue }
  try {
    if ($name -eq 'py.exe') { & $candidate.Source -3 -c "import sys" 2>$null }
    else { & $candidate.Source -c "import sys" 2>$null }
    if ($LASTEXITCODE -eq 0) {
      $python = $candidate.Source
      if ($name -eq 'py.exe') { $pythonArgs = '-3' }
      break
    }
  } catch {}
}
if ($null -eq $python) { throw 'Python 3 was not found in PATH' }
Write-Output 'TERAX_WINDOWS'
Write-Output (([Environment]::GetFolderPath('UserProfile')) -replace '\\', '/')
Write-Output 'powershell.exe'
Write-Output $python
Write-Output $pythonArgs"#;
    let output = capture_command(windows_remote_command(host, script, false)?, None)?;
    let mut lines = output.lines();
    if lines.next().map(str::trim) != Some("TERAX_WINDOWS") {
        return Err("not a Windows SSH account".into());
    }
    let home = lines.next().unwrap_or("").trim().to_string();
    let shell = lines.next().unwrap_or("powershell.exe").trim().to_string();
    let python_command = lines.next().unwrap_or("").trim().to_string();
    let python_arg = lines.next().unwrap_or("").trim();
    if home.is_empty() || python_command.is_empty() {
        return Err("Windows remote requires a user profile and Python 3".into());
    }
    Ok(RemoteProbe {
        platform: RemotePlatform::Windows,
        home,
        shell,
        python_command,
        python_args: (!python_arg.is_empty())
            .then(|| python_arg.to_string())
            .into_iter()
            .collect(),
    })
}

fn connect_blocking(app: AppHandle, host: String) -> Result<SshConnectInfo, String> {
    validate_host(&host)?;
    let probe = probe_posix(&host).or_else(|posix_error| {
        probe_windows(&host).map_err(|windows_error| {
            format!("could not connect to {host}: POSIX probe: {posix_error}; Windows probe: {windows_error}")
        })
    })?;

    match probe.platform {
        RemotePlatform::Posix => install_posix_remote_files(&host)?,
        RemotePlatform::Windows => install_windows_remote_files(&host, &probe.home)?,
    }

    let conn = Arc::new(SshConnection {
        host: host.clone(),
        home: probe.home.clone(),
        login_shell: probe.shell.clone(),
        platform: probe.platform,
        python_command: probe.python_command,
        python_args: probe.python_args,
        app,
        agent: Mutex::new(None),
    });
    // Verify the agent actually starts before declaring success.
    conn.agent()?;
    registry().insert(conn);

    Ok(SshConnectInfo {
        host,
        home: probe.home,
        shell: probe.shell,
        platform: probe.platform,
    })
}

#[tauri::command]
pub async fn ssh_connect(app: AppHandle, host: String) -> Result<SshConnectInfo, String> {
    tauri::async_runtime::spawn_blocking(move || connect_blocking(app, host))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ssh_disconnect(host: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(conn) = registry().remove(&host) {
            conn.shutdown();
        }
        // Tear down the multiplexing master too.
        if let Ok(mut cmd) = ssh_command(&host) {
            cmd.arg("-O").arg("exit");
            cmd.stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            crate::modules::proc::hide_console(&mut cmd);
            let _ = cmd.status();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
pub struct SshHostEntry {
    pub host: String,
    pub connected: bool,
}

/// Host aliases from ~/.ssh/config (wildcard/negated patterns skipped).
#[tauri::command]
pub fn ssh_list_hosts() -> Vec<SshHostEntry> {
    let mut hosts: Vec<String> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        if let Ok(config) = std::fs::read_to_string(home.join(".ssh").join("config")) {
            for line in config.lines() {
                let line = line.trim();
                let Some(rest) = line
                    .strip_prefix("Host ")
                    .or_else(|| line.strip_prefix("host "))
                else {
                    continue;
                };
                for token in rest.split_whitespace() {
                    if token.contains(['*', '?', '!']) || hosts.iter().any(|h| h == token) {
                        continue;
                    }
                    hosts.push(token.to_string());
                }
            }
        }
    }
    let connected: Vec<String> = registry()
        .conns
        .lock()
        .expect("ssh registry poisoned")
        .keys()
        .cloned()
        .collect();
    // Connected hosts that aren't in the config (manual entries) still show up.
    for h in &connected {
        if !hosts.iter().any(|x| x == h) {
            hosts.insert(0, h.clone());
        }
    }
    hosts
        .into_iter()
        .map(|host| SshHostEntry {
            connected: connected.iter().any(|c| c == &host),
            host,
        })
        .collect()
}

#[tauri::command]
pub fn ssh_home(host: String) -> Result<String, String> {
    Ok(registry().connection(&host)?.home.clone())
}

#[tauri::command]
pub async fn ssh_set_clipboard_image(host: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_host(&host)?;
        let conn = registry().connection(&host)?;
        if conn.platform != RemotePlatform::Windows {
            return Err("remote clipboard images are only supported on Windows".to_string());
        }
        fsops::set_clipboard_image(&host, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Picks a local port to forward onto, preferring `preferred`. Falls back to an
/// OS-assigned ephemeral port when `preferred` is already bound locally. The
/// probe socket is dropped before we hand the port to ssh, so there's a small
/// TOCTOU window — ssh surfaces an error if something grabs it first.
fn pick_local_port(preferred: u16) -> Result<u16, String> {
    use std::net::TcpListener;
    if let Ok(l) = TcpListener::bind(("127.0.0.1", preferred)) {
        let port = l.local_addr().map_err(|e| e.to_string())?.port();
        return Ok(port);
    }
    let l = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("no free local port: {e}"))?;
    l.local_addr().map_err(|e| e.to_string()).map(|a| a.port())
}

/// True when `port` is in LISTEN state on the host. Lets the frontend verify a
/// text-detected port is real before offering to forward it. Best-effort across
/// platforms (Linux `/proc`, BSD/macOS `ss`/`netstat`); treats "can't tell" as
/// listening so we don't suppress a genuine server we just couldn't probe.
#[tauri::command]
pub async fn ssh_port_listening(host: String, port: u16) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_host(&host)?;
        let p = port;
        let script = if platform(&host)? == RemotePlatform::Windows {
            format!(
                "$found = Get-NetTCPConnection -State Listen -LocalPort {p} -ErrorAction SilentlyContinue\n\
                 if ($null -ne $found) {{ 'LISTENING' }} else {{ 'NO' }}"
            )
        } else {
            format!(
                "if command -v ss >/dev/null 2>&1; then \
               ss -Hltn 2>/dev/null | grep -qE '[:.]{p}([^0-9]|$)' && echo LISTENING || echo NO; \
             elif [ -r /proc/net/tcp ]; then \
               hex=$(printf '%04X' {p}); \
               grep -iE \":$hex .* 0a \" /proc/net/tcp /proc/net/tcp6 2>/dev/null | grep -q . && echo LISTENING || echo NO; \
             elif command -v netstat >/dev/null 2>&1; then \
               netstat -ltn 2>/dev/null | grep -qE '[:.]{p}([^0-9]|$)' && echo LISTENING || echo NO; \
              else echo UNKNOWN; fi"
            )
        };
        let out = exec_capture(&host, &script)?;
        Ok(out.contains("LISTENING") || out.contains("UNKNOWN"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Forwards a local port to `localhost:remote_port` on the host through the
/// already-established ControlMaster (`ssh -O forward`). Returns the local port
/// actually bound (may differ from `remote_port` if that was busy locally).
#[tauri::command]
pub async fn ssh_forward_port(host: String, remote_port: u16) -> Result<u16, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_host(&host)?;
        let local_port = pick_local_port(remote_port)?;
        let spec = format!("{local_port}:localhost:{remote_port}");
        let mut cmd = ssh_command(&host)?;
        cmd.arg("-O").arg("forward").arg("-L").arg(&spec);
        cmd.stdin(Stdio::null());
        crate::modules::proc::hide_console(&mut cmd);
        let out = cmd.output().map_err(|e| format!("ssh spawn failed: {e}"))?;
        if out.status.success() {
            Ok(local_port)
        } else {
            Err(format!(
                "port forward failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tears down a forward previously created by [`ssh_forward_port`].
#[tauri::command]
pub async fn ssh_cancel_port(
    host: String,
    local_port: u16,
    remote_port: u16,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_host(&host)?;
        let spec = format!("{local_port}:localhost:{remote_port}");
        let mut cmd = ssh_command(&host)?;
        cmd.arg("-O").arg("cancel").arg("-L").arg(&spec);
        cmd.stdin(Stdio::null());
        crate::modules::proc::hide_console(&mut cmd);
        let out = cmd.output().map_err(|e| format!("ssh spawn failed: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "port cancel failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_host_accepts_common_forms() {
        assert!(validate_host("genie65").is_ok());
        assert!(validate_host("user@server.example.com").is_ok());
        assert!(validate_host("10.0.0.5").is_ok());
        assert!(validate_host("host-1_a.b").is_ok());
    }

    #[test]
    fn validate_host_rejects_injection() {
        assert!(validate_host("").is_err());
        assert!(validate_host("-oProxyCommand=evil").is_err());
        assert!(validate_host("host name").is_err());
        assert!(validate_host("host;rm").is_err());
        assert!(validate_host("host'quote").is_err());
        assert!(validate_host("host$(x)").is_err());
    }

    #[test]
    fn b64_matches_known_vectors() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"f"), "Zg==");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        assert_eq!(b64_encode(b"foo"), "Zm9v");
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn sh_quote_escapes_single_quotes() {
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn ps_quote_escapes_single_quotes() {
        assert_eq!(ps_quote("C:\\Users\\O'Brien"), "'C:\\Users\\O''Brien'");
    }

    #[test]
    fn powershell_encoding_is_utf16le_base64() {
        assert_eq!(powershell_encoded_arg("A"), "QQA=");
    }

    #[test]
    fn remote_script_arg_is_single_line_shell_neutral() {
        let arg = remote_script_arg("echo 'multi\nline' && pwd");
        assert!(!arg.contains('\n'));
        assert!(arg.starts_with("echo "));
        assert!(arg.ends_with("| base64 -d | sh"));
    }

    #[test]
    fn remote_stream_script_arg_preserves_stdin_and_is_shell_neutral() {
        let arg = remote_stream_script_arg("exec some-server --stdio");
        // Single line, no `$` (csh/tcsh login shells must parse it verbatim).
        assert!(!arg.contains('\n'));
        assert!(!arg.contains('$'));
        // Decodes to a temp file and runs `sh <file>` as a separate command so
        // the server inherits the SSH channel stdin, not the base64 pipe.
        assert!(arg.starts_with("echo "));
        assert!(arg.contains("| base64 -d > /tmp/terax-lsp-"));
        assert!(arg.contains(" ; sh /tmp/terax-lsp-"));
        assert!(arg.contains(" ; rm -f /tmp/terax-lsp-"));
        // NOT the stdin-consuming `| sh` form.
        assert!(!arg.contains("| base64 -d | sh"));
    }

    /// Live end-to-end check against a real host. Run with:
    ///   TERAX_SSH_TEST_HOST=genie65 cargo test ssh_live -- --nocapture
    #[test]
    fn ssh_live_install_and_agent_roundtrip() {
        let Ok(host) = std::env::var("TERAX_SSH_TEST_HOST") else {
            return;
        };
        use serde_json::json;

        // Exec wrapper survives hostile content + csh-family login shells.
        let out = exec_capture(&host, "echo 'it'\\''s a \"multi\nline\" test' && pwd").unwrap();
        assert!(out.contains("it's a \"multi\nline\" test"), "got: {out}");

        let probe = probe_posix(&host).expect("probe POSIX host");
        install_posix_remote_files(&host).expect("install remote files");

        let agent = agent::AgentHandle::spawn(
            &host,
            probe.platform,
            &probe.home,
            &probe.python_command,
            &probe.python_args,
            |paths| println!("fs_changed event: {paths:?}"),
        )
        .expect("agent spawn + hello");

        let t = agent::DEFAULT_TIMEOUT;
        let home = agent
            .request("hello", json!({}), t)
            .unwrap()
            .get("home")
            .and_then(serde_json::Value::as_str)
            .unwrap()
            .to_string();
        println!("remote home: {home}");

        let dir = format!("{home}/.cache/terax/.livetest");
        let _ = agent.request("delete", json!({"path": dir.clone()}), t);
        agent
            .request("create_dir", json!({"path": dir.clone()}), t)
            .expect("create_dir");

        // Write/read roundtrip with non-ASCII + quotes.
        let file = format!("{dir}/héllo it's.txt");
        let content = "line1\nline2 with 'quotes' and ünïcode\n";
        agent
            .request("write_file", json!({"path": file, "content": content}), t)
            .expect("write_file");
        let read = agent
            .request("read_file", json!({"path": file, "limit": 1048576}), t)
            .expect("read_file");
        assert_eq!(
            read.get("content").and_then(serde_json::Value::as_str),
            Some(content)
        );

        let listing = agent
            .request("read_dir", json!({"path": dir, "show_hidden": false}), t)
            .expect("read_dir");
        assert_eq!(listing.as_array().map(Vec::len), Some(1));

        let grep = agent
            .request(
                "grep",
                json!({"pattern": "quotes", "root": dir, "globs": [], "case_insensitive": false, "max_results": 10}),
                t,
            )
            .expect("grep");
        assert_eq!(
            grep.get("hits")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len),
            Some(1)
        );

        let stat = agent
            .request("stat", json!({"path": file}), t)
            .expect("stat");
        assert_eq!(
            stat.get("kind").and_then(serde_json::Value::as_str),
            Some("file")
        );

        agent
            .request("delete", json!({"path": dir}), t)
            .expect("delete");
        agent.shutdown();
        println!("ssh live roundtrip OK on {host}");
    }
}
