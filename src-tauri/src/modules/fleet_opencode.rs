//! Fleet board, opencode v2 source: sessions on the host's shared opencode
//! service (`opencode serve --service`). Discovery is the service's own
//! `~/.local/state/opencode/service.json` ({url, password, …}); nothing here
//! starts a service — no file or no answer means no opencode rows.
//!
//! Local hosts talk HTTP directly; POSIX SSH hosts run `curl` remotely (the
//! service only listens on the remote's loopback). Rows reuse `FleetAgent`
//! with `kind: "opencode"` and the session id (`ses_…`) as both ids.

use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;

use crate::modules::fleet::{ensure_posix, validate_id, FleetAgent, UNSUPPORTED_WSL};
use crate::modules::ssh;
use crate::modules::workspace::WorkspaceEnv;

/// Sessions idle longer than this drop off the board (busy ones always show).
const RECENT_MS: i64 = 24 * 60 * 60 * 1000;
const LIST_LIMIT: u32 = 30;
const MAX_MESSAGES: u32 = 200;
const HTTP_TIMEOUT: Duration = Duration::from_secs(4);
/// Starts each section header line in the remote list script's output.
const MARKER: &str = "@@TERAX_OC@@ ";
const NOT_RUNNING: &str = "opencode service is not running";

#[derive(Deserialize)]
struct Service {
    url: String,
    password: String,
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

#[derive(Deserialize, Default)]
struct Session {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    time: SessionTime,
    #[serde(default)]
    location: Option<Location>,
}

#[derive(Deserialize, Default)]
struct SessionTime {
    #[serde(default)]
    created: Option<i64>,
    #[serde(default)]
    updated: Option<i64>,
}

#[derive(Deserialize)]
struct Location {
    #[serde(default)]
    directory: String,
}

#[derive(Deserialize)]
struct PermissionRequest {
    #[serde(default)]
    action: String,
}

#[derive(Deserialize)]
struct FormInfo {
    #[serde(default)]
    title: String,
}

/// Raw bodies of one listing: sessions, active map, and the pending
/// permission / form lists of each busy session.
#[derive(Default)]
struct Snapshot {
    sessions: String,
    active: String,
    permissions: HashMap<String, String>,
    forms: HashMap<String, String>,
}

#[tauri::command]
pub async fn fleet_list_opencode(
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<FleetAgent>, String> {
    let now = now_ms();
    let snapshot = match WorkspaceEnv::from_option(workspace) {
        WorkspaceEnv::Local => local_snapshot().await?,
        WorkspaceEnv::Ssh { host } => tauri::async_runtime::spawn_blocking(move || {
            ensure_posix(&host)?;
            Ok::<_, String>(parse_remote_snapshot(&ssh::exec_capture(
                &host,
                &remote_list_script(),
            )?))
        })
        .await
        .map_err(err)??,
        WorkspaceEnv::Wsl { .. } => return Err(UNSUPPORTED_WSL.to_string()),
    };
    match snapshot {
        Some(snapshot) => build_rows(&snapshot, now),
        None => Ok(Vec::new()),
    }
}

/// Newest `limit` messages of a session (`GET /api/session/{id}/message`,
/// newest first), as the raw JSON body for the frontend to parse.
#[tauri::command]
pub async fn fleet_opencode_messages(
    workspace: Option<WorkspaceEnv>,
    id: String,
    limit: u32,
) -> Result<String, String> {
    validate_id(&id)?;
    let path = format!(
        "/api/session/{id}/message?limit={}&order=desc",
        limit.clamp(1, MAX_MESSAGES)
    );
    request(workspace, false, path)
        .await?
        .ok_or_else(|| NOT_RUNNING.to_string())
}

/// Stop the session's current run (`POST /api/session/{id}/interrupt`). The
/// session itself stays and can be prompted again.
#[tauri::command]
pub async fn fleet_opencode_interrupt(
    workspace: Option<WorkspaceEnv>,
    id: String,
) -> Result<(), String> {
    validate_id(&id)?;
    request(workspace, true, format!("/api/session/{id}/interrupt"))
        .await?
        .map(|_| ())
        .ok_or_else(|| NOT_RUNNING.to_string())
}

/// One authenticated request to the host's service. `Ok(None)` when there's
/// no service to talk to.
async fn request(
    workspace: Option<WorkspaceEnv>,
    post: bool,
    path: String,
) -> Result<Option<String>, String> {
    match WorkspaceEnv::from_option(workspace) {
        WorkspaceEnv::Local => {
            let Some(service) = local_service() else {
                return Ok(None);
            };
            local_request(&client()?, &service, post, &path)
                .await
                .map(Some)
        }
        WorkspaceEnv::Ssh { host } => tauri::async_runtime::spawn_blocking(move || {
            ensure_posix(&host)?;
            let method = if post { "-X POST" } else { "" };
            let out = ssh::exec_capture(&host, &remote_request_script(method, &path))?;
            // The script prints nothing at all when there's no service.
            Ok((!out.is_empty()).then_some(out))
        })
        .await
        .map_err(err)?,
        WorkspaceEnv::Wsl { .. } => Err(UNSUPPORTED_WSL.to_string()),
    }
}

async fn local_request(
    client: &reqwest::Client,
    service: &Service,
    post: bool,
    path: &str,
) -> Result<String, String> {
    let url = format!("{}{path}", service.url);
    let req = if post {
        client.post(url)
    } else {
        client.get(url)
    };
    req.basic_auth("opencode", Some(&service.password))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(err)?
        .text()
        .await
        .map_err(err)
}

/// `None` when there's no service file or it doesn't answer (not running).
async fn local_snapshot() -> Result<Option<Snapshot>, String> {
    let Some(service) = local_service() else {
        return Ok(None);
    };
    let client = client()?;
    let Ok(sessions) = local_request(&client, &service, false, &sessions_path()).await else {
        return Ok(None);
    };
    let active = local_request(&client, &service, false, "/api/session/active").await?;
    let mut snapshot = Snapshot {
        sessions,
        active,
        ..Default::default()
    };
    for id in active_ids(&snapshot.active) {
        let base = format!("/api/session/{id}");
        if let Ok(body) =
            local_request(&client, &service, false, &format!("{base}/permission")).await
        {
            snapshot.permissions.insert(id.clone(), body);
        }
        if let Ok(body) = local_request(&client, &service, false, &format!("{base}/form")).await {
            snapshot.forms.insert(id, body);
        }
    }
    Ok(Some(snapshot))
}

fn err(e: impl std::fmt::Display) -> String {
    format!("opencode: {e}")
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(err)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sessions_path() -> String {
    format!("/api/session?parentID=null&order=desc&limit={LIST_LIMIT}")
}

fn local_service() -> Option<Service> {
    let path = dirs::home_dir()?.join(".local/state/opencode/service.json");
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn active_ids(active: &str) -> Vec<String> {
    serde_json::from_str::<Envelope<HashMap<String, serde_json::Value>>>(active.trim())
        .map(|a| a.data.into_keys().collect())
        .unwrap_or_default()
}

/// POSIX sh prelude defining `oc <curl args>`, an authenticated request to
/// the service at `$url`; exits quietly when there's no service. The password
/// goes to curl on stdin (`-K -`), never on a command line other users could
/// see in `ps`.
const REMOTE_PRELUDE: &str = r#"f="$HOME/.local/state/opencode/service.json"
[ -f "$f" ] || exit 0
command -v curl >/dev/null 2>&1 || { echo 'curl is not installed on this host' >&2; exit 127; }
url=$(sed -n 's/.*"url" *: *"\([^"]*\)".*/\1/p' "$f")
pw=$(sed -n 's/.*"password" *: *"\([^"]*\)".*/\1/p' "$f")
[ -n "$url" ] || exit 0
oc() { printf 'user = "opencode:%s"\n' "$pw" | curl -sS -m 4 -f -K - "$@"; }
"#;

fn remote_request_script(method: &str, path: &str) -> String {
    format!("{REMOTE_PRELUDE}oc {method} \"$url{path}\"\n")
}

/// Prints the sessions body, then `MARKER`-headed sections: `active`, and
/// `perm <id>` / `form <id>` for every busy session. Service down → the first
/// request fails and nothing is printed.
fn remote_list_script() -> String {
    format!(
        r#"{REMOTE_PRELUDE}s=$(oc "$url{sessions}") || exit 0
a=$(oc "$url/api/session/active") || a='{{"data":{{}}}}'
printf '%s\n' "$s"
printf '{MARKER}active\n%s\n' "$a"
for id in $(printf '%s' "$a" | grep -o '"ses_[A-Za-z0-9_-]*"' | tr -d '"'); do
  printf '{MARKER}perm %s\n' "$id"; oc "$url/api/session/$id/permission"; echo
  printf '{MARKER}form %s\n' "$id"; oc "$url/api/session/$id/form"; echo
done
"#,
        sessions = sessions_path()
    )
}

fn parse_remote_snapshot(out: &str) -> Option<Snapshot> {
    let separator = format!("\n{MARKER}");
    let mut sections = out.split(&separator);
    let sessions = sections.next()?.trim();
    if sessions.is_empty() {
        return None;
    }
    let mut snapshot = Snapshot {
        sessions: sessions.to_string(),
        ..Default::default()
    };
    for section in sections {
        let (header, body) = section.split_once('\n').unwrap_or((section, ""));
        let body = body.trim().to_string();
        match header.trim().split_once(' ') {
            Some(("perm", id)) => {
                snapshot.permissions.insert(id.to_string(), body);
            }
            Some(("form", id)) => {
                snapshot.forms.insert(id.to_string(), body);
            }
            _ if header.trim() == "active" => snapshot.active = body,
            _ => {}
        }
    }
    Some(snapshot)
}

/// What a busy session is blocked on, phrased like Claude's `waitingFor`
/// ("permission prompt") so the board highlights it the same way.
fn waiting_for(snapshot: &Snapshot, id: &str) -> Option<String> {
    let parse = |body: Option<&String>| body.map(|b| b.trim().to_string());
    if let Some(Ok(p)) = parse(snapshot.permissions.get(id))
        .map(|b| serde_json::from_str::<Envelope<Vec<PermissionRequest>>>(&b))
    {
        if let Some(first) = p.data.first() {
            return Some(if first.action.is_empty() {
                "permission prompt".to_string()
            } else {
                format!("permission prompt ({})", first.action)
            });
        }
    }
    if let Some(Ok(f)) =
        parse(snapshot.forms.get(id)).map(|b| serde_json::from_str::<Envelope<Vec<FormInfo>>>(&b))
    {
        if let Some(first) = f.data.first() {
            return Some(format!("question: {}", first.title));
        }
    }
    None
}

fn build_rows(snapshot: &Snapshot, now: i64) -> Result<Vec<FleetAgent>, String> {
    let sessions: Envelope<Vec<Session>> =
        serde_json::from_str(snapshot.sessions.trim()).map_err(err)?;
    let active = active_ids(&snapshot.active);
    Ok(sessions
        .data
        .into_iter()
        .filter_map(|s| {
            let busy = active.contains(&s.id);
            let updated = s.time.updated.or(s.time.created).unwrap_or(0);
            if !busy && now - updated > RECENT_MS {
                return None;
            }
            Some(FleetAgent {
                pid: None,
                cwd: s.location.map(|l| l.directory).unwrap_or_default(),
                kind: "opencode".to_string(),
                started_at: s.time.created,
                id: Some(s.id.clone()),
                waiting_for: if busy {
                    waiting_for(snapshot, &s.id)
                } else {
                    None
                },
                name: if s.title.is_empty() {
                    s.id.clone()
                } else {
                    s.title
                },
                session_id: s.id,
                status: if busy { "busy" } else { "idle" }.to_string(),
                // The last run's outcome is stale while a new one is running.
                state: if busy { None } else { s.outcome },
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSIONS: &str = r#"{"data":[
      {"id":"ses_agent-a","title":"agent-a","time":{"created":1000,"updated":5000},"location":{"directory":"/w/a"},"tokens":{}},
      {"id":"ses_old","title":"","outcome":"succeeded","time":{"created":1,"updated":2},"location":{"directory":"/w/b"}},
      {"id":"ses_done","title":"done one","outcome":"succeeded","time":{"created":10,"updated":4000}}
    ],"cursor":{}}"#;

    fn snapshot(active: &str) -> Snapshot {
        Snapshot {
            sessions: SESSIONS.to_string(),
            active: active.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn builds_rows_marking_active_busy_and_dropping_stale_idle() {
        let snap = snapshot(r#"{"data":{"ses_agent-a":{"type":"running"}}}"#);
        let rows = build_rows(&snap, 3000 + RECENT_MS).unwrap();
        // ses_old: idle and too old. ses_done: idle but updated within RECENT_MS.
        let ids: Vec<_> = rows.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, ["ses_agent-a", "ses_done"]);
        assert_eq!(rows[0].kind, "opencode");
        assert_eq!(rows[0].status, "busy");
        assert_eq!(rows[0].cwd, "/w/a");
        assert_eq!(rows[0].id.as_deref(), Some("ses_agent-a"));
        assert_eq!(rows[0].waiting_for, None);
        assert_eq!(rows[1].status, "idle");
        assert_eq!(rows[1].state.as_deref(), Some("succeeded"));
        assert_eq!(rows[1].cwd, "");
    }

    #[test]
    fn untitled_session_is_named_by_id() {
        let rows = build_rows(&snapshot(r#"{"data":{}}"#), 0).unwrap();
        assert_eq!(rows[1].name, "ses_old");
    }

    #[test]
    fn pending_permission_or_form_sets_waiting_for() {
        let out = format!(
            "{SESSIONS}\n{MARKER}active\n{{\"data\":{{\"ses_agent-a\":{{\"type\":\"running\"}},\"ses_done\":{{\"type\":\"running\"}}}}}}\n\
             {MARKER}perm ses_agent-a\n{{\"data\":[{{\"id\":\"per_1\",\"sessionID\":\"ses_agent-a\",\"action\":\"bash\",\"resources\":[\"ls\"]}}]}}\n\
             {MARKER}form ses_agent-a\n{{\"data\":[]}}\n\
             {MARKER}perm ses_done\n{{\"data\":[]}}\n\
             {MARKER}form ses_done\n{{\"data\":[{{\"id\":\"frm_1\",\"sessionID\":\"ses_done\",\"title\":\"Pick one\",\"fields\":[]}}]}}\n"
        );
        let snap = parse_remote_snapshot(&out).unwrap();
        let rows = build_rows(&snap, 0).unwrap();
        assert_eq!(
            rows[0].waiting_for.as_deref(),
            Some("permission prompt (bash)")
        );
        assert_eq!(rows[2].waiting_for.as_deref(), Some("question: Pick one"));
    }

    #[test]
    fn empty_remote_output_means_no_service() {
        assert!(parse_remote_snapshot("").is_none());
    }

    #[test]
    fn remote_scripts_keep_password_off_the_command_line() {
        for s in [remote_list_script(), remote_request_script("-X POST", "/x")] {
            assert!(s.contains("curl -sS -m 4 -f -K -"));
            assert!(!s.contains("-u "));
        }
    }

    /// Runs the remote script through local `sh` against this machine's
    /// service: `cargo test --lib live_remote_script -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_remote_script_lists_local_service() {
        let out = std::process::Command::new("sh")
            .args(["-c", &remote_list_script()])
            .output()
            .unwrap();
        let out = String::from_utf8_lossy(&out.stdout);
        let snap = parse_remote_snapshot(&out).expect("no service running");
        let rows = build_rows(&snap, now_ms()).unwrap();
        for r in &rows {
            println!(
                "{} {} {:?} {} {}",
                r.session_id, r.status, r.waiting_for, r.name, r.cwd
            );
        }
    }
}
