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
        let handle = agent::AgentHandle::spawn(&self.host, move |paths| {
            let _ = app.emit("fs:changed", FsChangedPayload { paths });
        })?;
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

/// Wraps an arbitrary POSIX script so it survives ANY remote login shell
/// (tcsh/csh users included): the top-level command sshd hands to the login
/// shell is plain `echo <base64> | base64 -d | sh`, which every shell parses
/// identically. Newlines, quotes, and unicode in `script` are all safe.
pub fn remote_script_arg(script: &str) -> String {
    format!("echo {} | base64 -d | sh", b64_encode(script.as_bytes()))
}

/// `ssh host -- <wrapped script>`: runs `script` under POSIX `sh` on the host.
pub fn remote_shell_command(host: &str, script: &str) -> Result<Command, String> {
    let mut cmd = ssh_command(host)?;
    cmd.arg("--");
    cmd.arg(remote_script_arg(script));
    Ok(cmd)
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
    let mut cmd = ssh_command(host)?;
    cmd.arg("--").arg("true");
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

/// Uploads the remote agent + shell-integration scripts in a single ssh exec
/// (script streamed over stdin, like `ssh host sh`). Idempotent; runs on every
/// connect so the agent is always the version this build expects.
fn install_remote_files(host: &str) -> Result<(), String> {
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

#[derive(Serialize, Clone)]
pub struct SshConnectInfo {
    pub host: String,
    pub home: String,
    pub shell: String,
}

fn connect_blocking(app: AppHandle, host: String) -> Result<SshConnectInfo, String> {
    validate_host(&host)?;

    // One exec both establishes the control master and probes the account.
    let probe = exec_capture(
        &host,
        "printf '%s\\n%s\\n%s\\n' \"$HOME\" \"$SHELL\" \"$(command -v python3 || echo missing)\"",
    )
    .map_err(|e| format!("could not connect to {host}: {e}"))?;
    let mut lines = probe.lines();
    let home = lines.next().unwrap_or("").trim().to_string();
    let shell = lines.next().unwrap_or("").trim().to_string();
    let python3 = lines.next().unwrap_or("").trim().to_string();
    if home.is_empty() {
        return Err(format!("could not resolve $HOME on {host}"));
    }
    if python3 == "missing" || python3.is_empty() {
        return Err(format!(
            "Terax remote requires python3 on {host} (not found in PATH)"
        ));
    }

    install_remote_files(&host)?;

    let conn = Arc::new(SshConnection {
        host: host.clone(),
        home: home.clone(),
        login_shell: shell.clone(),
        app,
        agent: Mutex::new(None),
    });
    // Verify the agent actually starts before declaring success.
    conn.agent()?;
    registry().insert(conn);

    Ok(SshConnectInfo { host, home, shell })
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
        let script = format!(
            "if command -v ss >/dev/null 2>&1; then \
               ss -Hltn 2>/dev/null | grep -qE '[:.]{p}([^0-9]|$)' && echo LISTENING || echo NO; \
             elif [ -r /proc/net/tcp ]; then \
               hex=$(printf '%04X' {p}); \
               grep -iE \":$hex .* 0a \" /proc/net/tcp /proc/net/tcp6 2>/dev/null | grep -q . && echo LISTENING || echo NO; \
             elif command -v netstat >/dev/null 2>&1; then \
               netstat -ltn 2>/dev/null | grep -qE '[:.]{p}([^0-9]|$)' && echo LISTENING || echo NO; \
             else echo UNKNOWN; fi"
        );
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
        let _ = cmd.output();
        Ok(())
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
    fn remote_script_arg_is_single_line_shell_neutral() {
        let arg = remote_script_arg("echo 'multi\nline' && pwd");
        assert!(!arg.contains('\n'));
        assert!(arg.starts_with("echo "));
        assert!(arg.ends_with("| base64 -d | sh"));
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

        install_remote_files(&host).expect("install remote files");

        let agent = agent::AgentHandle::spawn(&host, |paths| {
            println!("fs_changed event: {paths:?}");
        })
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
