use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::modules::workspace::WorkspaceEnv;

const LIST_FORMAT: &str = "#{session_name}\t#{session_path}\t#{pane_current_command}\t#{session_windows}\t#{session_created}\t#{@terax_nick}";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub name: String,
    pub path: String,
    pub command: String,
    pub windows: u32,
    pub created: i64,
    pub nickname: String,
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

const PANE_FORMAT: &str = "#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}";

/// Find the agent's actual pane through process ancestry, select it, and return
/// its session name so the frontend can reuse a tab or attach a new client.
#[tauri::command]
pub async fn tmux_open_process(
    workspace: Option<WorkspaceEnv>,
    pid: u32,
) -> Result<Option<String>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || {
        let (processes, panes) = match &workspace {
            WorkspaceEnv::Local => {
                let Some(tmux) = local_tmux_path() else {
                    return Ok(None);
                };
                let panes = Command::new(tmux)
                    .args(["-u", "list-panes", "-a", "-F", PANE_FORMAT])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !panes.status.success() {
                    return Ok(None);
                }
                let processes = Command::new("ps")
                    .args(["-axo", "pid=,ppid="])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !processes.status.success() {
                    return Err("Could not read the tmux process tree".to_string());
                }
                (
                    String::from_utf8_lossy(&processes.stdout).into_owned(),
                    String::from_utf8_lossy(&panes.stdout).into_owned(),
                )
            }
            WorkspaceEnv::Ssh { host } => {
                crate::modules::fleet::ensure_posix(host)?;
                let script = format!(
                    "{}\n[ -n \"$tmux_bin\" ] || exit 0\n\
                     ps -axo pid=,ppid= || exit 1\n\
                     printf '\\nTERAX_PANES\\n'\n\
                     \"$tmux_bin\" -u list-panes -a -F {} 2>/dev/null || true\n",
                    remote_tmux_resolve_script(),
                    crate::modules::ssh::sh_quote(PANE_FORMAT),
                );
                let output = crate::modules::ssh::exec_capture(host, &script)?;
                let Some((processes, panes)) = output.split_once("\nTERAX_PANES\n") else {
                    return Ok(None);
                };
                (processes.to_string(), panes.to_string())
            }
            WorkspaceEnv::Wsl { .. } => return Ok(None),
        };
        let Some((name, window, pane)) = process_pane(pid, &processes, &panes) else {
            return Ok(None);
        };
        match workspace {
            WorkspaceEnv::Local => {
                let tmux = local_tmux_path().ok_or_else(|| "tmux is not installed".to_string())?;
                for (command, target) in [("select-window", &window), ("select-pane", &pane)] {
                    let output = Command::new(&tmux)
                        .args(["-u", command, "-t", target])
                        .output()
                        .map_err(|e| e.to_string())?;
                    if !output.status.success() {
                        return Err("The agent's tmux pane is no longer available".to_string());
                    }
                }
            }
            WorkspaceEnv::Ssh { host } => {
                let script = format!(
                    "{}\n[ -n \"$tmux_bin\" ] || exit 127\n\
                     \"$tmux_bin\" -u select-window -t {} && \"$tmux_bin\" -u select-pane -t {}\n",
                    remote_tmux_resolve_script(),
                    crate::modules::ssh::sh_quote(&window),
                    crate::modules::ssh::sh_quote(&pane),
                );
                crate::modules::ssh::exec_capture(&host, &script)?;
            }
            WorkspaceEnv::Wsl { .. } => unreachable!(),
        }
        Ok(Some(name))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn process_pane(pid: u32, processes: &str, panes: &str) -> Option<(String, String, String)> {
    let rows: Vec<_> = panes
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let name = fields.next()?;
            let window = fields.next()?;
            let pane = fields.next()?;
            let shell: u32 = fields.next()?.parse().ok()?;
            if !tmux_id(window, '@') || !tmux_id(pane, '%') {
                return None;
            }
            Some((name, window, pane, shell))
        })
        .collect();
    let shells = rows
        .iter()
        .enumerate()
        .map(|(i, row)| (row.3, i as u32))
        .collect();
    let index = crate::modules::pty::process_lookup::find_pty(
        pid,
        &crate::modules::pty::process_lookup::parse_pairs(processes),
        &shells,
    )?;
    let (name, window, pane, _) = rows.get(index as usize)?;
    Some((name.to_string(), window.to_string(), pane.to_string()))
}

fn tmux_id(value: &str, prefix: char) -> bool {
    value.strip_prefix(prefix)
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
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

/// Stores a display nickname as the `@terax_nick` user option on the session,
/// so it lives with the tmux server (survives app restarts, works over SSH).
/// An empty nickname clears it.
#[tauri::command]
pub async fn tmux_set_nickname(
    workspace: Option<WorkspaceEnv>,
    name: String,
    nickname: String,
) -> Result<(), String> {
    if !name.starts_with("terax-") {
        return Err("refusing to modify non-Terax tmux session".to_string());
    }
    let nickname: String = nickname
        .chars()
        .filter(|c| !c.is_control())
        .take(60)
        .collect::<String>()
        .trim()
        .to_string();
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || match workspace {
        WorkspaceEnv::Local => local_set_nickname(&name, &nickname),
        WorkspaceEnv::Ssh { host } => remote_set_nickname(&host, &name, &nickname),
        WorkspaceEnv::Wsl { .. } => Err("tmux is not supported for WSL yet".to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn local_available() -> bool {
    local_tmux_path().is_some()
}

fn local_list() -> Result<String, String> {
    let Some(tmux) = local_tmux_path() else {
        return Ok(String::new());
    };
    let mut cmd = Command::new(tmux);
    // -u: without a UTF-8 locale (app launched from Finder/Dock) tmux rewrites
    // the tab separators and non-ASCII chars in -F output to `_`.
    cmd.args(["-u", "ls", "-F", LIST_FORMAT]);
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
    cmd.args(["-u", "kill-session", "-t", name]);
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

fn local_set_nickname(name: &str, nickname: &str) -> Result<(), String> {
    let tmux = local_tmux_path().ok_or_else(|| "tmux is not installed".to_string())?;
    let mut cmd = Command::new(tmux);
    if nickname.is_empty() {
        cmd.args(["-u", "set-option", "-u", "-t", name, "@terax_nick"]);
    } else {
        cmd.args(["-u", "set-option", "-t", name, "@terax_nick", nickname]);
    }
    crate::modules::proc::hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("tmux rename failed: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!(
        "tmux rename failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

fn remote_set_nickname(host: &str, name: &str, nickname: &str) -> Result<(), String> {
    if crate::modules::ssh::platform(host)? == crate::modules::ssh::RemotePlatform::Windows {
        return Err("tmux is not supported on Windows SSH hosts".into());
    }
    let quote = crate::modules::ssh::sh_quote;
    let set = if nickname.is_empty() {
        format!("set-option -u -t {} @terax_nick", quote(name))
    } else {
        format!(
            "set-option -t {} @terax_nick {}",
            quote(name),
            quote(nickname)
        )
    };
    let script = format!(
        "{}\n[ -n \"$tmux_bin\" ] || exit 127\n\"$tmux_bin\" -u {set}\n",
        remote_tmux_resolve_script()
    );
    crate::modules::ssh::exec_capture(host, &script).map(|_| ())
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
        "{}\n[ -n \"$tmux_bin\" ] || exit 0\n\"$tmux_bin\" -u ls -F {} 2>/dev/null || true\n",
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
        "{}\n[ -n \"$tmux_bin\" ] || exit 127\n\"$tmux_bin\" -u kill-session -t {}\n",
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

pub(crate) fn command_path(name: &str) -> Option<String> {
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
            let nickname = parts.next().unwrap_or_default().to_string();
            Some(TmuxSession {
                name,
                path,
                command,
                windows,
                created,
                nickname,
            })
        })
        .collect()
}

#[cfg(test)]
mod process_tests {
    use super::*;

    #[test]
    fn finds_the_exact_pane_through_process_wrappers() {
        assert_eq!(
            process_pane(50, "50 40\n40 30\n30 1", "other\t@1\t%1\t20\nterax-agent\t@2\t%3\t30"),
            Some(("terax-agent".to_string(), "@2".to_string(), "%3".to_string()))
        );
    }

    #[test]
    fn does_not_guess_from_session_names() {
        assert_eq!(process_pane(50, "50 1", "agent\t@2\t%3\t30"), None);
    }

    #[test]
    fn rejects_malformed_pane_targets() {
        assert_eq!(process_pane(50, "50 30", "agent\t@2\t%3;bad\t30"), None);
        assert_eq!(process_pane(50, "50 30", "agent\t@\t%3\t30"), None);
    }
}
