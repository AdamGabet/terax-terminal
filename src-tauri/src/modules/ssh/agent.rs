use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use shared_child::SharedChild;

/// Must match AGENT_VERSION in agent.py.
const AGENT_VERSION: u64 = 5;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const SLOW_TIMEOUT: Duration = Duration::from_secs(120);

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;

/// One persistent `ssh host python3 agent.py` process speaking JSON-lines.
/// Requests are multiplexed by id; unsolicited `fs_changed` events are
/// delivered to `on_fs_changed` (the connection forwards them to the webview
/// as the same `fs:changed` event the local watcher emits).
pub struct AgentHandle {
    child: Arc<SharedChild>,
    stdin: Mutex<std::process::ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    shutting_down: Arc<AtomicBool>,
}

impl AgentHandle {
    pub fn spawn<F>(
        host: &str,
        platform: super::RemotePlatform,
        home: &str,
        python_command: &str,
        python_args: &[String],
        on_fs_changed: F,
    ) -> Result<Arc<Self>, String>
    where
        F: Fn(Vec<String>) + Send + 'static,
    {
        let mut cmd = match platform {
            super::RemotePlatform::Posix => {
                let mut cmd = super::ssh_command(host)?;
                // Single-line, quote-free command: parses identically under any
                // POSIX login shell. sshd starts in $HOME.
                let mut parts = vec![super::sh_quote(python_command)];
                parts.extend(python_args.iter().map(|a| super::sh_quote(a)));
                parts.push(super::REMOTE_AGENT_PATH.to_string());
                cmd.arg("--").arg(parts.join(" "));
                cmd
            }
            super::RemotePlatform::Windows => {
                let agent_path = format!(
                    "{}\\.cache\\terax\\remote\\agent.py",
                    home.trim_end_matches(['\\', '/'])
                );
                let mut script = format!("& {}", super::ps_quote(python_command));
                for arg in python_args {
                    script.push(' ');
                    script.push_str(&super::ps_quote(arg));
                }
                script.push(' ');
                script.push_str(&super::ps_quote(&agent_path));
                super::windows_remote_command(host, &script, false)?
            }
        };
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::modules::proc::hide_console(&mut cmd);

        let child =
            Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| format!("ssh agent spawn: {e}"))?);
        let stdin = child.take_stdin().ok_or("ssh agent: no stdin pipe")?;
        let stdout = child.take_stdout().ok_or("ssh agent: no stdout pipe")?;
        let stderr = child.take_stderr().ok_or("ssh agent: no stderr pipe")?;

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let shutting_down = Arc::new(AtomicBool::new(false));

        {
            let pending = pending.clone();
            let alive = alive.clone();
            let shutting_down = shutting_down.clone();
            let host = host.to_string();
            thread::Builder::new()
                .name("terax-ssh-agent-reader".into())
                .spawn(move || {
                    let reader = BufReader::new(stdout);
                    for line in reader.lines() {
                        let Ok(line) = line else { break };
                        if line.trim().is_empty() {
                            continue;
                        }
                        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                            log::debug!("ssh agent {host}: unparseable line");
                            continue;
                        };
                        if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                            let sender = pending.lock().expect("ssh pending poisoned").remove(&id);
                            if let Some(tx) = sender {
                                let result = if msg.get("ok").and_then(Value::as_bool) == Some(true)
                                {
                                    Ok(msg.get("data").cloned().unwrap_or(Value::Null))
                                } else {
                                    Err(msg
                                        .get("error")
                                        .and_then(Value::as_str)
                                        .unwrap_or("remote agent error")
                                        .to_string())
                                };
                                let _ = tx.send(result);
                            }
                        } else if msg.get("event").and_then(Value::as_str) == Some("fs_changed") {
                            let paths: Vec<String> = msg
                                .get("paths")
                                .and_then(Value::as_array)
                                .map(|a| {
                                    a.iter()
                                        .filter_map(Value::as_str)
                                        .map(str::to_string)
                                        .collect()
                                })
                                .unwrap_or_default();
                            if !paths.is_empty() {
                                on_fs_changed(paths);
                            }
                        }
                    }
                    alive.store(false, Ordering::Release);
                    // Fail anything still waiting so callers don't block to timeout.
                    let mut map = pending.lock().expect("ssh pending poisoned");
                    for (_, tx) in map.drain() {
                        let _ = tx.send(Err("SSH remote agent disconnected".into()));
                    }
                    if shutting_down.load(Ordering::Acquire) {
                        log::debug!("ssh agent for {host} stopped");
                    } else {
                        log::warn!("ssh agent stream for {host} closed unexpectedly");
                    }
                })
                .map_err(|e| e.to_string())?;
        }

        thread::Builder::new()
            .name("terax-ssh-agent-stderr".into())
            .spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    log::debug!("ssh agent stderr: {line}");
                }
            })
            .map_err(|e| e.to_string())?;

        let handle = Arc::new(Self {
            child,
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            alive,
            shutting_down,
        });

        // Handshake: proves python3 ran the script and versions agree.
        let hello = handle.request("hello", json!({}), DEFAULT_TIMEOUT)?;
        let version = hello.get("version").and_then(Value::as_u64).unwrap_or(0);
        if version != AGENT_VERSION {
            handle.shutdown();
            return Err(format!(
                "remote agent version mismatch (got {version}, want {AGENT_VERSION})"
            ));
        }
        Ok(handle)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        self.alive.store(false, Ordering::Release);
        self.reap();
    }

    /// `kill` only signals; without a matching `wait` the ssh process lingers
    /// as a zombie for the life of the app (`shared_child` has no `Drop` of its
    /// own). Agents respawn on every network drop, so this would accumulate.
    /// Safe to call repeatedly — `SharedChild` caches the exit status.
    fn reap(&self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// Sends one request and blocks for its reply. Safe to call from multiple
    /// threads; the agent handles requests concurrently on the remote side.
    pub fn request(&self, op: &str, mut params: Value, timeout: Duration) -> Result<Value, String> {
        if !self.is_alive() {
            return Err("SSH remote agent disconnected".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let obj = params
            .as_object_mut()
            .ok_or("ssh agent request params must be an object")?;
        obj.insert("id".into(), json!(id));
        obj.insert("op".into(), json!(op));
        let line = serde_json::to_string(&params).map_err(|e| e.to_string())? + "\n";

        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .expect("ssh pending poisoned")
            .insert(id, tx);

        {
            let mut stdin = self.stdin.lock().expect("ssh stdin poisoned");
            if let Err(e) = stdin
                .write_all(line.as_bytes())
                .and_then(|()| stdin.flush())
            {
                self.pending
                    .lock()
                    .expect("ssh pending poisoned")
                    .remove(&id);
                return Err(format!("ssh agent write failed: {e}"));
            }
        }

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                self.pending
                    .lock()
                    .expect("ssh pending poisoned")
                    .remove(&id);
                Err(format!("ssh remote operation '{op}' timed out"))
            }
        }
    }
}

impl Drop for AgentHandle {
    fn drop(&mut self) {
        self.shutting_down.store(true, Ordering::Release);
        self.reap();
    }
}
