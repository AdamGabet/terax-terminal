use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::modules::workspace::WorkspaceEnv;

const LIST_FORMAT: &str = "#{session_name}\t#{session_path}\t#{pane_current_command}\t#{session_windows}\t#{session_created}";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub name: String,
    pub path: String,
    pub command: String,
    pub windows: u32,
    pub created: i64,
}

#[tauri::command]
pub fn tmux_available(workspace: Option<WorkspaceEnv>) -> Result<bool, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    match workspace {
        WorkspaceEnv::Local => Ok(local_available()),
        WorkspaceEnv::Ssh { host } => remote_available(&host),
        WorkspaceEnv::Wsl { .. } => Ok(false),
    }
}

#[tauri::command]
pub fn tmux_list(workspace: Option<WorkspaceEnv>) -> Result<Vec<TmuxSession>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let output = match workspace {
        WorkspaceEnv::Local => local_list()?,
        WorkspaceEnv::Ssh { host } => remote_list(&host)?,
        WorkspaceEnv::Wsl { .. } => return Ok(Vec::new()),
    };
    Ok(parse_list(&output))
}

#[tauri::command]
pub fn tmux_kill(workspace: Option<WorkspaceEnv>, name: String) -> Result<(), String> {
    if !name.starts_with("terax-") {
        return Err("refusing to kill non-Terax tmux session".to_string());
    }
    let workspace = WorkspaceEnv::from_option(workspace);
    match workspace {
        WorkspaceEnv::Local => local_kill(&name),
        WorkspaceEnv::Ssh { host } => remote_kill(&host, &name),
        WorkspaceEnv::Wsl { .. } => Err("tmux is not supported for WSL yet".to_string()),
    }
}

fn local_available() -> bool {
    local_tmux_path().is_some()
}

fn local_list() -> Result<String, String> {
    let Some(tmux) = local_tmux_path() else {
        return Ok(String::new());
    };
    let mut cmd = Command::new(tmux);
    cmd.args(["ls", "-F", LIST_FORMAT]);
    crate::modules::proc::hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("tmux ls failed: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("no server running") || stderr.contains("failed to connect") {
        return Ok(String::new());
    }
    Err(format!("tmux ls failed: {}", stderr.trim()))
}

fn local_kill(name: &str) -> Result<(), String> {
    let tmux = local_tmux_path().ok_or_else(|| "tmux is not installed".to_string())?;
    let mut cmd = Command::new(tmux);
    cmd.args(["kill-session", "-t", name]);
    crate::modules::proc::hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("tmux kill failed: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!(
        "tmux kill failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

fn remote_available(host: &str) -> Result<bool, String> {
    if crate::modules::ssh::platform(host)? == crate::modules::ssh::RemotePlatform::Windows {
        return Ok(false);
    }
    match crate::modules::ssh::exec_capture(
        host,
        &format!(
            "{}\n[ -n \"$tmux_bin\" ] && echo yes || echo no\n",
            remote_tmux_resolve_script()
        ),
    ) {
        Ok(out) => Ok(out.trim() == "yes"),
        Err(e) => Err(e),
    }
}

fn remote_list(host: &str) -> Result<String, String> {
    if crate::modules::ssh::platform(host)? == crate::modules::ssh::RemotePlatform::Windows {
        return Ok(String::new());
    }
    let script = format!(
        "{}\n[ -n \"$tmux_bin\" ] || exit 0\n\"$tmux_bin\" ls -F {} 2>/dev/null || true\n",
        remote_tmux_resolve_script(),
        crate::modules::ssh::sh_quote(LIST_FORMAT)
    );
    crate::modules::ssh::exec_capture(host, &script)
}

fn remote_kill(host: &str, name: &str) -> Result<(), String> {
    if crate::modules::ssh::platform(host)? == crate::modules::ssh::RemotePlatform::Windows {
        return Err("tmux is not supported on Windows SSH hosts".into());
    }
    let script = format!(
        "{}\n[ -n \"$tmux_bin\" ] || exit 127\n\"$tmux_bin\" kill-session -t {}\n",
        remote_tmux_resolve_script(),
        crate::modules::ssh::sh_quote(name)
    );
    crate::modules::ssh::exec_capture(host, &script).map(|_| ())
}

fn local_tmux_path() -> Option<String> {
    if let Some(path) = command_path("tmux") {
        return Some(path);
    }
    let home = std::env::var("HOME").ok();
    common_tmux_paths(home.as_deref())
        .into_iter()
        .find(|path| Path::new(path).is_file())
}

fn command_path(name: &str) -> Option<String> {
    let mut cmd = Command::new("sh");
    cmd.arg("-lc")
        .arg(format!("command -v {} 2>/dev/null", name));
    crate::modules::proc::hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

fn common_tmux_paths(home: Option<&str>) -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(format!("{home}/.local/bin/tmux"));
        paths.push(format!("{home}/bin/tmux"));
    }
    paths.extend([
        "/opt/homebrew/bin/tmux".to_string(),
        "/usr/local/bin/tmux".to_string(),
        "/usr/bin/tmux".to_string(),
        "/bin/tmux".to_string(),
    ]);
    paths
}

fn remote_tmux_resolve_script() -> &'static str {
    r#"tmux_bin=$(command -v tmux 2>/dev/null || true)
if [ -z "$tmux_bin" ]; then
  for candidate in "$HOME/.local/bin/tmux" "$HOME/bin/tmux" /opt/homebrew/bin/tmux /usr/local/bin/tmux /usr/bin/tmux /bin/tmux; do
    if [ -x "$candidate" ]; then
      tmux_bin=$candidate
      break
    fi
  done
fi"#
}

fn parse_list(output: &str) -> Vec<TmuxSession> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let name = parts.next()?.to_string();
            if !name.starts_with("terax-") {
                return None;
            }
            let path = parts.next().unwrap_or_default().to_string();
            let command = parts.next().unwrap_or_default().to_string();
            let windows = parts.next().unwrap_or("1").parse().unwrap_or(1);
            let created = parts.next().unwrap_or("0").parse().unwrap_or(0);
            Some(TmuxSession {
                name,
                path,
                command,
                windows,
                created,
            })
        })
        .collect()
}
