//! Fleet board: Claude Code sessions on a host, listed through the CLI's own
//! `claude agents --json --all` (source of truth — headless `-p` loops and
//! `--bg` sessions both appear, unlike the OSC detector which only sees open
//! panes). Routed by `WorkspaceEnv` like tmux.rs: local exec or POSIX SSH.
//! Windows hosts are not supported yet.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::modules::ssh::{self, sh_quote, RemotePlatform};
use crate::modules::workspace::WorkspaceEnv;

/// One row of `claude agents --json`. Unknown fields are ignored so newer
/// CLIs don't break the board; everything but `sessionId` is optional.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FleetAgent {
    #[serde(default)]
    pub pid: Option<u64>,
    #[serde(default)]
    pub cwd: String,
    /// "interactive" (incl. `-p`) or "background" (`--bg`, attachable).
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub started_at: Option<i64>,
    /// Background sessions only: short job id (e.g. "59be4b42") that
    /// `claude attach` / `claude stop` match on — they reject the sessionId.
    #[serde(default)]
    pub id: Option<String>,
    pub session_id: String,
    #[serde(default)]
    pub name: String,
    /// "busy" | "idle".
    #[serde(default)]
    pub status: String,
    /// Background sessions only, e.g. "running" | "blocked".
    #[serde(default)]
    pub state: Option<String>,
    /// Background sessions only, e.g. "permission prompt".
    #[serde(default)]
    pub waiting_for: Option<String>,
}

/// Hard cap on transcript tail reads; JSONL lines with tool results are big.
const MAX_TAIL_BYTES: u64 = 4 * 1024 * 1024;

#[tauri::command]
pub async fn fleet_list(workspace: Option<WorkspaceEnv>) -> Result<Vec<FleetAgent>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || {
        let output = match workspace {
            WorkspaceEnv::Local => local_claude(["agents", "--json", "--all"])?,
            WorkspaceEnv::Ssh { host } => remote_claude(&host, "agents --json --all")?,
            WorkspaceEnv::Wsl { .. } => return Err(UNSUPPORTED_WSL.to_string()),
        };
        parse_agents(&output)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fleet_stop(workspace: Option<WorkspaceEnv>, id: String) -> Result<(), String> {
    validate_id(&id)?;
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || match workspace {
        WorkspaceEnv::Local => local_claude(["stop", id.as_str()]).map(|_| ()),
        WorkspaceEnv::Ssh { host } => {
            remote_claude(&host, &format!("stop {}", sh_quote(&id))).map(|_| ())
        }
        WorkspaceEnv::Wsl { .. } => Err(UNSUPPORTED_WSL.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Continue a finished/stopped/removed session in the background:
/// `claude --bg --resume <sid> --name <name>` run from `cwd` (the transcript
/// lives under the cwd's project slug). If the session is still running the
/// CLI starts a copy instead and says so. Returns the CLI's output (first
/// line `backgrounded · <id> · <name>`).
#[tauri::command]
pub async fn fleet_resume(
    workspace: Option<WorkspaceEnv>,
    cwd: String,
    session_id: String,
    name: String,
) -> Result<String, String> {
    validate_session_uuid(&session_id)?;
    validate_id(&name)?;
    if cwd.trim().is_empty() {
        return Err("resume needs the session's cwd".to_string());
    }
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || match workspace {
        WorkspaceEnv::Local => local_resume(&cwd, &session_id, &name),
        WorkspaceEnv::Ssh { host } => {
            ensure_posix(&host)?;
            ssh::exec_capture(&host, &remote_resume_script(&cwd, &session_id, &name))
        }
        WorkspaceEnv::Wsl { .. } => Err(UNSUPPORTED_WSL.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Last `max_bytes` of the session's transcript
/// (`~/.claude/projects/<cwd slug>/<sessionId>.jsonl`). The caller drops the
/// first partial line. Errors if the file doesn't exist yet.
#[tauri::command]
pub async fn fleet_transcript_tail(
    workspace: Option<WorkspaceEnv>,
    cwd: String,
    session_id: String,
    max_bytes: u64,
) -> Result<String, String> {
    validate_id(&session_id)?;
    let max_bytes = max_bytes.clamp(1, MAX_TAIL_BYTES);
    let slug = project_slug(&cwd);
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || match workspace {
        WorkspaceEnv::Local => {
            let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
            let projects = Path::new(&home).join(".claude/projects");
            local_tail(&find_transcript(&projects, &slug, &session_id), max_bytes)
        }
        WorkspaceEnv::Ssh { host } => {
            ensure_posix(&host)?;
            ssh::exec_capture(&host, &remote_tail_script(&slug, &session_id, max_bytes))
        }
        WorkspaceEnv::Wsl { .. } => Err(UNSUPPORTED_WSL.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) const UNSUPPORTED_WSL: &str = "Fleet is not supported for WSL yet";

pub(crate) fn ensure_posix(host: &str) -> Result<(), String> {
    if ssh::platform(host)? == RemotePlatform::Windows {
        return Err("Fleet is not supported on Windows SSH hosts yet".to_string());
    }
    Ok(())
}

/// Session ids / names reach shell commands; keep them to the CLI's own
/// alphabet (uuid fragments and `--name` values).
pub(crate) fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid session id: {id:?}"));
    }
    Ok(())
}

/// Full session ids are lowercase UUIDs (`8-4-4-4-12` hex).
fn validate_session_uuid(id: &str) -> Result<(), String> {
    let ok = id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit() && !c.is_ascii_uppercase(),
        });
    if !ok {
        return Err(format!("invalid session id: {id:?}"));
    }
    Ok(())
}

fn resume_args<'a>(session_id: &'a str, name: &'a str) -> [&'a str; 5] {
    ["--bg", "--resume", session_id, "--name", name]
}

fn local_resume(cwd: &str, session_id: &str, name: &str) -> Result<String, String> {
    let claude = local_claude_path().ok_or_else(|| "claude is not installed".to_string())?;
    if !Path::new(cwd).is_dir() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    let mut cmd = Command::new(claude);
    cmd.args(resume_args(session_id, name)).current_dir(cwd);
    crate::modules::proc::hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("claude failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        // stderr carries notes like "already running … started a copy".
        return Ok(format!("{}\n{}", stdout.trim(), stderr.trim())
            .trim()
            .to_string());
    }
    Err(format!("claude --bg --resume failed: {}", stderr.trim()))
}

fn remote_resume_script(cwd: &str, session_id: &str, name: &str) -> String {
    let args = resume_args(session_id, name)
        .iter()
        .map(|a| sh_quote(a))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "{}\n[ -n \"$claude_bin\" ] || {{ echo 'claude is not installed on this host' >&2; exit 127; }}\ncd {} && \"$claude_bin\" {args}\n",
        remote_claude_resolve_script(),
        sh_quote(cwd)
    )
}

/// Claude Code's transcript directory name: every non-alphanumeric byte of
/// the cwd becomes `-` (`/a/b.c_d` → `-a-b-c-d`).
pub fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn parse_agents(output: &str) -> Result<Vec<FleetAgent>, String> {
    // The CLI may print notices before the array (update prompts etc.).
    let start = output.find('[').ok_or_else(|| {
        format!(
            "claude agents --json produced no JSON array: {}",
            output.trim()
        )
    })?;
    serde_json::from_str(&output[start..]).map_err(|e| format!("claude agents --json: {e}"))
}

fn local_claude<const N: usize>(args: [&str; N]) -> Result<String, String> {
    let claude = local_claude_path().ok_or_else(|| "claude is not installed".to_string())?;
    let mut cmd = Command::new(claude);
    cmd.args(args);
    crate::modules::proc::hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("claude failed: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    Err(format!(
        "claude {} failed: {}",
        args[0],
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

fn remote_claude(host: &str, args: &str) -> Result<String, String> {
    ensure_posix(host)?;
    let script = format!(
        "{}\n[ -n \"$claude_bin\" ] || {{ echo 'claude is not installed on this host' >&2; exit 127; }}\n\"$claude_bin\" {args}\n",
        remote_claude_resolve_script()
    );
    ssh::exec_capture(host, &script)
}

fn local_claude_path() -> Option<String> {
    if let Some(path) = crate::modules::tmux::command_path("claude") {
        return Some(path);
    }
    let home = std::env::var("HOME").ok();
    common_claude_paths(home.as_deref())
        .into_iter()
        .find(|path| Path::new(path).is_file())
}

fn common_claude_paths(home: Option<&str>) -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(format!("{home}/.local/bin/claude"));
        paths.push(format!("{home}/.claude/local/claude"));
        paths.push(format!("{home}/.npm-global/bin/claude"));
    }
    paths.extend([
        "/opt/homebrew/bin/claude".to_string(),
        "/usr/local/bin/claude".to_string(),
        "/usr/bin/claude".to_string(),
    ]);
    paths
}

// tcsh login shells (genie65) don't put ~/.local/bin on PATH for non-login
// `sh`, so fall back to the usual install locations.
fn remote_claude_resolve_script() -> &'static str {
    r#"claude_bin=$(command -v claude 2>/dev/null || true)
if [ -z "$claude_bin" ]; then
  for candidate in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "$HOME/.npm-global/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude /usr/bin/claude; do
    if [ -x "$candidate" ]; then
      claude_bin=$candidate
      break
    fi
  done
fi"#
}

/// The transcript normally sits under the cwd's slug, but not always: a
/// session in a worktree (`<repo>/.claude/worktrees/<name>`) is filed under
/// the directory it was launched from. Session ids are unique, so fall back
/// to any project dir holding `<sid>.jsonl`.
fn find_transcript(projects: &Path, slug: &str, session_id: &str) -> PathBuf {
    let file = format!("{session_id}.jsonl");
    let direct = projects.join(slug).join(&file);
    if direct.is_file() {
        return direct;
    }
    std::fs::read_dir(projects)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path().join(&file))
        .find(|p| p.is_file())
        .unwrap_or(direct)
}

fn remote_tail_script(slug: &str, session_id: &str, max_bytes: u64) -> String {
    let dir = sh_quote(&format!(".claude/projects/{slug}"));
    // session_id is validated to [A-Za-z0-9_-], safe unquoted in the glob.
    format!(
        "f=\"$HOME\"/{dir}/{session_id}.jsonl\n[ -f \"$f\" ] || for g in \"$HOME\"/.claude/projects/*/{session_id}.jsonl; do f=$g; break; done\ntail -c {max_bytes} \"$f\"\n"
    )
}

fn local_tail(path: &Path, max_bytes: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len > max_bytes {
        file.seek(SeekFrom::Start(len - max_bytes))
            .map_err(|e| e.to_string())?;
    }
    let mut buf = Vec::with_capacity(len.min(max_bytes) as usize);
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cli_listing_and_tolerates_extra_fields() {
        let json = r#"Notice: something
[
  {"pid":1,"cwd":"/a","kind":"interactive","startedAt":5,"sessionId":"s1","name":"n1","status":"busy","extra":1},
  {"pid":2,"id":"59be4b42","cwd":"/b","kind":"background","startedAt":6,"sessionId":"s2","name":"n2","status":"idle","state":"blocked","waitingFor":"permission prompt"}
]"#;
        let agents = parse_agents(json).unwrap();
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].kind, "interactive");
        assert_eq!(agents[0].waiting_for, None);
        assert_eq!(agents[0].id, None);
        assert_eq!(agents[1].id.as_deref(), Some("59be4b42"));
        assert_eq!(agents[1].state.as_deref(), Some("blocked"));
        assert_eq!(agents[1].waiting_for.as_deref(), Some("permission prompt"));
        assert!(parse_agents("not json").is_err());
        assert_eq!(parse_agents("[]").unwrap(), vec![]);
    }

    #[test]
    fn serializes_camel_case_for_the_frontend() {
        let a = FleetAgent {
            session_id: "s".into(),
            waiting_for: Some("permission prompt".into()),
            ..Default::default()
        };
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["sessionId"], "s");
        assert_eq!(v["waitingFor"], "permission prompt");
        assert!(v.get("session_id").is_none());
    }

    #[test]
    fn project_slug_matches_claude_code() {
        assert_eq!(
            project_slug("/Users/adamgabet/Documents/coding/construction_ohad"),
            "-Users-adamgabet-Documents-coding-construction-ohad"
        );
        assert_eq!(project_slug("/a/b.c"), "-a-b-c");
    }

    #[test]
    fn rejects_ids_that_could_escape_the_shell() {
        assert!(validate_id("53b92f77-7dd7-48be-b840-bf210d6e6a33").is_ok());
        assert!(validate_id("agent_A").is_ok());
        assert!(validate_id("").is_err());
        assert!(validate_id("x; rm -rf /").is_err());
        assert!(validate_id("../x").is_err());
    }

    #[test]
    fn resume_validates_and_builds_the_command() {
        assert!(validate_session_uuid("aad4bda3-b19b-491d-9225-06d23b4776d9").is_ok());
        assert!(validate_session_uuid("aad4bda3").is_err());
        assert!(validate_session_uuid("AAD4BDA3-B19B-491D-9225-06D23B4776D9").is_err());
        assert!(validate_session_uuid("aad4bda3-b19b-491d-9225-06d23b4776d;").is_err());
        assert!(validate_session_uuid("aad4bda3b-19b-491d-9225-06d23b4776d9").is_err());
        assert_eq!(
            resume_args("aad4bda3-b19b-491d-9225-06d23b4776d9", "probe-fmt"),
            [
                "--bg",
                "--resume",
                "aad4bda3-b19b-491d-9225-06d23b4776d9",
                "--name",
                "probe-fmt"
            ]
        );
        let script = remote_resume_script("/w/a b", "aad4bda3-b19b-491d-9225-06d23b4776d9", "x");
        assert!(script.contains("cd '/w/a b' && \"$claude_bin\" "));
        assert!(script.contains("--resume"));
    }

    /// Real run against the local CLI: `TERAX_RESUME_SID=<uuid>
    /// TERAX_RESUME_CWD=<dir> cargo test fleet -- --ignored`.
    #[test]
    #[ignore]
    fn local_resume_runs_claude() {
        let sid = std::env::var("TERAX_RESUME_SID").unwrap();
        let cwd = std::env::var("TERAX_RESUME_CWD").unwrap();
        let out = local_resume(&cwd, &sid, "probe-fmt").unwrap();
        println!("{out}");
        assert!(out.contains("backgrounded"));
    }

    #[test]
    fn local_tail_returns_last_bytes() {
        let dir = std::env::temp_dir().join(format!("terax-fleet-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, "0123456789").unwrap();
        assert_eq!(local_tail(&path, 4).unwrap(), "6789");
        assert_eq!(local_tail(&path, 100).unwrap(), "0123456789");
        assert!(local_tail(&dir.join("missing"), 4).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_transcript_falls_back_to_any_project_dir() {
        let dir = std::env::temp_dir().join(format!("terax-fleet-find-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("-repo")).unwrap();
        std::fs::write(dir.join("-repo/sid.jsonl"), "x").unwrap();
        // Worktree cwd slug has no dir; found under the launch dir instead.
        assert_eq!(
            find_transcript(&dir, "-repo--claude-worktrees-w", "sid"),
            dir.join("-repo/sid.jsonl")
        );
        assert_eq!(
            find_transcript(&dir, "-repo", "sid"),
            dir.join("-repo/sid.jsonl")
        );
        assert_eq!(
            find_transcript(&dir, "-x", "nope"),
            dir.join("-x/nope.jsonl")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
