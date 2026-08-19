//! Framed-process transport for LSP and DAP servers.
//!
//! Both protocols share the same `Content-Length` header framing over stdio;
//! this module spawns a server process, deframes its stdout into complete
//! JSON messages (delivered raw over a Channel), and frames outgoing
//! messages onto its stdin. The editor's language servers and the Python
//! debugger's debugpy adapter both ride on it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use shared_child::SharedChild;
use tauri::ipc::{Channel, Response};
use tauri::State;

use super::workspace::WorkspaceEnv;

/// Refuse absurd frames instead of allocating unbounded memory.
const MAX_FRAME_BYTES: usize = 128 * 1024 * 1024;
const STDERR_TAIL_CAP: usize = 8 * 1024;
const RSS_POLL_SECS: u64 = 5;

pub struct LspProc {
    child: Arc<SharedChild>,
    stdin: Mutex<Option<ChildStdin>>,
    /// Set by the memory watchdog before it kills; surfaced in exit info.
    kill_reason: Mutex<Option<String>>,
}

#[derive(Default)]
pub struct LspState {
    inner: Arc<Mutex<Registry>>,
}

#[derive(Default)]
struct Registry {
    next_id: u32,
    procs: HashMap<u32, Arc<LspProc>>,
}

#[derive(Clone, Serialize)]
pub struct LspExitInfo {
    pub code: Option<i32>,
    #[serde(rename = "stderrTail")]
    pub stderr_tail: String,
    pub reason: Option<String>,
}

fn build_command(
    command: &str,
    args: &[String],
    env: Option<&HashMap<String, String>>,
    root: &str,
    workspace: &WorkspaceEnv,
) -> Result<Command, String> {
    match workspace {
        WorkspaceEnv::Ssh { host } => {
            if let Some(vars) = env {
                for k in vars.keys() {
                    if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                        return Err(format!("invalid env var name: {k}"));
                    }
                }
            }
            super::ssh::remote_program_command(
                host,
                command,
                args,
                env,
                (!root.is_empty()).then_some(root),
                true,
            )
        }
        WorkspaceEnv::Wsl { .. } => Err("LSP/DAP servers are not supported in WSL yet".into()),
        WorkspaceEnv::Local => {
            let mut cmd = Command::new(command);
            cmd.args(args);
            if !root.is_empty() {
                cmd.current_dir(root);
            }
            if let Some(vars) = env {
                cmd.envs(vars);
            }
            Ok(cmd)
        }
    }
}

/// Reads one Content-Length framed message. `Ok(None)` means clean EOF.
fn read_frame(reader: &mut impl BufRead) -> std::io::Result<Option<Vec<u8>>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            if content_length.is_some() {
                break;
            }
            // Blank line before any header: tolerate and keep scanning.
            continue;
        }
        if let Some(v) = trimmed.strip_prefix("Content-Length:") {
            content_length = v.trim().parse().ok();
        }
    }
    let len = content_length.unwrap_or(0);
    if len == 0 || len > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("bad Content-Length: {len}"),
        ));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    Ok(Some(buf))
}

#[cfg(unix)]
fn rss_mb_of(pid: u32) -> Option<u64> {
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let kb: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some(kb / 1024)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn lsp_spawn(
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    root: String,
    max_rss_mb: Option<u64>,
    workspace: Option<WorkspaceEnv>,
    on_message: Channel<Response>,
    on_exit: Channel<LspExitInfo>,
    state: State<'_, LspState>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let mut cmd = build_command(&command, &args, env.as_ref(), &root, &workspace)?;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    super::proc::hide_console(&mut cmd);

    let child = Arc::new(
        SharedChild::spawn(&mut cmd).map_err(|e| format!("failed to start {command}: {e}"))?,
    );
    let stdin = child.take_stdin();
    // These bail before the exit watcher (the thing that normally reaps) is
    // started, so wait here or the corpse sticks around.
    let stdout = child.take_stdout().ok_or_else(|| {
        let _ = child.kill();
        let _ = child.wait();
        "no stdout pipe".to_string()
    })?;
    let stderr = child.take_stderr().ok_or_else(|| {
        let _ = child.kill();
        let _ = child.wait();
        "no stderr pipe".to_string()
    })?;

    let proc = Arc::new(LspProc {
        child: child.clone(),
        stdin: Mutex::new(stdin),
        kill_reason: Mutex::new(None),
    });

    let id = {
        let mut reg = state.inner.lock().unwrap();
        reg.next_id += 1;
        let id = reg.next_id;
        reg.procs.insert(id, proc.clone());
        id
    };

    // stdout → deframe → message channel
    {
        let mut reader = BufReader::new(stdout);
        thread::spawn(move || loop {
            match read_frame(&mut reader) {
                Ok(Some(body)) => {
                    if on_message.send(Response::new(body)).is_err() {
                        break;
                    }
                }
                Ok(None) | Err(_) => break,
            }
        });
    }

    // stderr → rolling tail for exit diagnostics
    let tail: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let tail = tail.clone();
        let mut pipe = stderr;
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut t = tail.lock().unwrap();
                        t.extend_from_slice(&buf[..n]);
                        let overflow = t.len().saturating_sub(STDERR_TAIL_CAP);
                        if overflow > 0 {
                            t.drain(..overflow);
                        }
                    }
                }
            }
        });
    }

    // Memory watchdog (local only: a remote server's RSS isn't ours to read).
    #[cfg(unix)]
    if let (Some(cap_mb), WorkspaceEnv::Local) = (max_rss_mb, &workspace) {
        let proc_ref = proc.clone();
        let pid = child.id();
        thread::spawn(move || loop {
            thread::sleep(std::time::Duration::from_secs(RSS_POLL_SECS));
            if proc_ref
                .child
                .try_wait()
                .map(|s| s.is_some())
                .unwrap_or(true)
            {
                break;
            }
            let Some(rss) = rss_mb_of(pid) else { break };
            if rss > cap_mb {
                *proc_ref.kill_reason.lock().unwrap() =
                    Some(format!("memory budget exceeded ({rss} MB > {cap_mb} MB)"));
                let _ = proc_ref.child.kill();
                break;
            }
        });
    }
    #[cfg(not(unix))]
    let _ = max_rss_mb;

    // Exit watcher: authoritative cleanup + exit notification.
    {
        let registry = state.inner.clone();
        let proc_ref = proc;
        thread::spawn(move || {
            let code = match proc_ref.child.wait() {
                Ok(status) => status.code(),
                Err(_) => None,
            };
            registry.lock().unwrap().procs.remove(&id);
            let stderr_tail = String::from_utf8_lossy(&tail.lock().unwrap()).into_owned();
            let reason = proc_ref.kill_reason.lock().unwrap().take();
            let _ = on_exit.send(LspExitInfo {
                code,
                stderr_tail,
                reason,
            });
        });
    }

    Ok(id)
}

#[tauri::command]
pub async fn lsp_send(id: u32, message: String, state: State<'_, LspState>) -> Result<(), String> {
    let proc = state
        .inner
        .lock()
        .unwrap()
        .procs
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no such server session: {id}"))?;
    let mut guard = proc.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("server stdin is closed")?;
    let mut frame = Vec::with_capacity(message.len() + 32);
    frame.extend_from_slice(format!("Content-Length: {}\r\n\r\n", message.len()).as_bytes());
    frame.extend_from_slice(message.as_bytes());
    stdin
        .write_all(&frame)
        .and_then(|_| stdin.flush())
        .map_err(|e| {
            *guard = None;
            format!("write to server failed: {e}")
        })
}

#[tauri::command]
pub async fn lsp_kill(id: u32, state: State<'_, LspState>) -> Result<(), String> {
    let proc = state.inner.lock().unwrap().procs.remove(&id);
    if let Some(proc) = proc {
        let _ = proc.child.kill();
    }
    Ok(())
}

/// Nearest ancestor of `path` containing any of `markers`. Local paths only —
/// remote LSP resolves roots on its own side.
#[tauri::command]
pub async fn lsp_resolve_root(
    path: String,
    markers: Vec<String>,
) -> Result<Option<String>, String> {
    let start = PathBuf::from(&path);
    let mut dir: Option<&std::path::Path> = if start.is_dir() {
        Some(start.as_path())
    } else {
        start.parent()
    };
    while let Some(d) = dir {
        if markers.iter().any(|m| d.join(m).exists()) {
            return Ok(Some(d.to_string_lossy().into_owned()));
        }
        dir = d.parent();
    }
    Ok(None)
}

fn is_executable(path: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Binary paths a venv/interpreter *directory* might expose for `command`,
/// in probe order. POSIX venvs put executables under `bin/`; Windows under
/// `Scripts/` (with an `.exe` shim), so probe both regardless of host — a
/// remote root may be POSIX while the app runs on Windows.
fn venv_bin_candidates(dir: &std::path::Path, command: &str) -> Vec<PathBuf> {
    vec![
        dir.join("bin").join(command),
        dir.join("Scripts").join(format!("{command}.exe")),
        dir.join("Scripts").join(command),
        dir.join("bin").join(format!("{command}.exe")),
    ]
}

/// POSIX venv binary candidates for a remote (SSH) directory. Remotes are
/// always POSIX, so only `bin/` applies; string join is used because the app
/// host may be Windows (a `PathBuf` there would emit backslashes).
fn remote_venv_candidates(host: &str, dir: &str, command: &str) -> Vec<String> {
    if super::ssh::platform(host).ok() == Some(super::ssh::RemotePlatform::Windows) {
        let d = dir.trim_end_matches(['/', '\\']);
        vec![
            format!("{d}\\Scripts\\{command}.exe"),
            format!("{d}\\Scripts\\{command}.cmd"),
            format!("{d}\\Scripts\\{command}"),
        ]
    } else {
        let d = dir.trim_end_matches('/');
        vec![format!("{d}/bin/{command}")]
    }
}

/// Remote counterpart of [`resolve_local`]: probe a venv on the SSH host with
/// the agent's `stat`. Order mirrors local — explicit path, `venv` override,
/// repo `.venv`/`venv`, then the bare command (resolved via the remote PATH at
/// spawn time so a globally-installed server still launches).
fn resolve_remote(
    host: &str,
    command: &str,
    root: Option<&str>,
    venv: Option<&str>,
) -> Option<String> {
    let exists = |p: &str| super::ssh::fsops::stat(host, p).is_ok();
    if command.contains(['/', '\\']) {
        return exists(command).then(|| command.to_string());
    }
    if let Some(v) = venv.map(str::trim).filter(|s| !s.is_empty()) {
        for cand in remote_venv_candidates(host, v, command) {
            if exists(&cand) {
                return Some(cand);
            }
        }
    }
    if let Some(r) = root.map(str::trim).filter(|s| !s.is_empty()) {
        let r = r.trim_end_matches('/');
        for venv_dir in [".venv", "venv"] {
            let dir =
                if super::ssh::platform(host).ok() == Some(super::ssh::RemotePlatform::Windows) {
                    format!("{}\\{venv_dir}", r.trim_end_matches(['/', '\\']))
                } else {
                    format!("{r}/{venv_dir}")
                };
            for cand in remote_venv_candidates(host, &dir, command) {
                if exists(&cand) {
                    return Some(cand);
                }
            }
        }
    }
    Some(command.to_string())
}

/// Resolve a bare LSP command for the given workspace: remote hosts probe the
/// SSH filesystem; local uses [`resolve_local`]; WSL is unsupported.
fn resolve_command(
    command: &str,
    root: Option<&str>,
    venv: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Option<String> {
    match workspace {
        WorkspaceEnv::Ssh { host } => resolve_remote(host, command, root, venv),
        WorkspaceEnv::Wsl { .. } => None,
        WorkspaceEnv::Local => {
            resolve_local(command, root, venv).map(|p| p.to_string_lossy().into_owned())
        }
    }
}

/// Resolve a bare LSP command to an absolute local path, preferring a Python
/// venv over PATH. Order: an explicit path is honored as-is; then the user's
/// manual `venv` override; then a repo-level `.venv`/`venv` under `root`; then
/// PATH. This is what lets `ruff`/`pyright-langserver` installed only inside a
/// project venv be found and launched instead of falling back to a global one.
fn resolve_local(command: &str, root: Option<&str>, venv: Option<&str>) -> Option<PathBuf> {
    if command.contains('/') || command.contains('\\') {
        let p = PathBuf::from(command);
        return is_executable(&p).then_some(p);
    }
    if let Some(v) = venv.map(str::trim).filter(|s| !s.is_empty()) {
        for cand in venv_bin_candidates(std::path::Path::new(v), command) {
            if is_executable(&cand) {
                return Some(cand);
            }
        }
    }
    if let Some(r) = root.map(str::trim).filter(|s| !s.is_empty()) {
        let root_path = std::path::Path::new(r);
        for venv_dir in [".venv", "venv"] {
            for cand in venv_bin_candidates(&root_path.join(venv_dir), command) {
                if is_executable(&cand) {
                    return Some(cand);
                }
            }
        }
    }
    which_on_path(command)
}

/// Resolve `command` to an absolute path the same way `lsp_spawn`'s
/// `Command::new` would: an explicit path is used as-is, otherwise each PATH
/// entry is probed (with PATHEXT extensions on Windows). Returns `None` when
/// nothing executable matches.
fn which_on_path(command: &str) -> Option<PathBuf> {
    if command.contains('/') || command.contains('\\') {
        let p = PathBuf::from(command);
        return is_executable(&p).then_some(p);
    }
    let path = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into())
        .split(';')
        .map(|s| s.to_string())
        .collect();
    #[cfg(not(windows))]
    let exts: Vec<String> = vec![String::new()];
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let candidate = dir.join(format!("{command}{ext}"));
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Resolve a language-server binary to an absolute path, checking a repo-level
/// venv and an optional manual venv override before PATH. Backs the "not found"
/// hint, the settings status line, and — via the returned path — the command
/// `sessionManager` actually spawns. Called with `root`/`venv` omitted (PATH
/// only) for the global availability check in Settings. When `workspace` is an
/// SSH host the venv is probed on the remote filesystem (network I/O, hence the
/// `spawn_blocking`); WSL is unsupported and resolves to nothing.
#[tauri::command]
pub async fn lsp_detect(
    command: String,
    root: Option<String>,
    venv: Option<String>,
    workspace: Option<WorkspaceEnv>,
) -> Result<Option<String>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || {
        resolve_command(&command, root.as_deref(), venv.as_deref(), &workspace)
    })
    .await
    .map_err(|e| e.to_string())
}

/// The app's own PID, handed to servers as `processId` so their parent
/// watchdog can exit with us.
#[tauri::command]
pub fn lsp_host_pid() -> u32 {
    std::process::id()
}
