//! MCP server exposing the Python debugger to MCP clients (Claude Code).
//!
//! Streamable-HTTP MCP endpoint on 127.0.0.1:<random port>, bearer-token
//! auth, discovery file at ~/.cache/terax/mcp.json. The debug session lives
//! entirely in the webview, so every tools/call is bridged: emit
//! `terax:mcp-request` to the registered window, the frontend McpBridge
//! executes it against the debugger store and answers via `mcp_respond`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State, Window};

const BRIDGE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const SSE_KEEPALIVE: Duration = Duration::from_secs(30);
const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Default)]
pub struct McpState {
    inner: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    /// In-flight bridged tool calls: request id → HTTP thread's reply slot.
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    /// Label of the window hosting the frontend McpBridge.
    window: Mutex<Option<String>>,
    server: Mutex<Option<ServerHandle>>,
    /// Live SSE subscribers (dead ones are dropped on the next notify).
    sse: Mutex<Vec<mpsc::Sender<String>>>,
}

struct ServerHandle {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
pub struct McpInfo {
    pub port: u16,
    pub token: String,
    pub endpoint: String,
    /// Ready-made `claude mcp add` line for the user to copy.
    #[serde(rename = "addCommand")]
    pub add_command: String,
}

fn info_of(port: u16, token: &str) -> McpInfo {
    McpInfo {
        port,
        token: token.to_string(),
        endpoint: format!("http://127.0.0.1:{port}/mcp"),
        add_command: format!(
            "claude mcp add --transport http terax-debug http://127.0.0.1:{port}/mcp \
             --header \"Authorization: Bearer {token}\""
        ),
    }
}

fn discovery_path() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home directory")?;
    Ok(home.join(".cache").join("terax").join("mcp.json"))
}

fn write_discovery(port: u16, token: &str) -> Result<(), String> {
    let path = discovery_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(&json!({ "port": port, "token": token }))
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("rng failure: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// --- commands ---

#[tauri::command]
pub async fn mcp_start(app: AppHandle, state: State<'_, McpState>) -> Result<McpInfo, String> {
    {
        let guard = state.inner.server.lock().unwrap();
        if let Some(s) = guard.as_ref() {
            return Ok(info_of(s.port, &s.token));
        }
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("failed to bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = new_token()?;
    let stop = Arc::new(AtomicBool::new(false));
    write_discovery(port, &token)?;

    {
        let shared = state.inner.clone();
        let token = token.clone();
        let stop = stop.clone();
        thread::spawn(move || accept_loop(listener, app, shared, token, stop));
    }

    let info = info_of(port, &token);
    *state.inner.server.lock().unwrap() = Some(ServerHandle { port, token, stop });
    Ok(info)
}

#[tauri::command]
pub async fn mcp_stop(state: State<'_, McpState>) -> Result<(), String> {
    let handle = state.inner.server.lock().unwrap().take();
    if let Some(s) = handle {
        s.stop.store(true, Ordering::SeqCst);
        // Unblock the accept loop so it sees the flag.
        let _ = TcpStream::connect(("127.0.0.1", s.port));
        if let Ok(path) = discovery_path() {
            let _ = std::fs::remove_file(path);
        }
    }
    // Dropping the senders ends every SSE stream on its next recv.
    state.inner.sse.lock().unwrap().clear();
    Ok(())
}

#[tauri::command]
pub async fn mcp_status(state: State<'_, McpState>) -> Result<Option<McpInfo>, String> {
    Ok(state
        .inner
        .server
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| info_of(s.port, &s.token)))
}

/// The frontend McpBridge announces itself; bridged calls route to this
/// window. A re-register (webview reload) drops any orphaned in-flight calls.
#[tauri::command]
pub async fn mcp_register(window: Window, state: State<'_, McpState>) -> Result<(), String> {
    *state.inner.window.lock().unwrap() = Some(window.label().to_string());
    state.inner.pending.lock().unwrap().clear();
    Ok(())
}

#[tauri::command]
pub async fn mcp_respond(
    id: u64,
    ok: bool,
    payload: Value,
    state: State<'_, McpState>,
) -> Result<(), String> {
    let sender = state.inner.pending.lock().unwrap().remove(&id);
    if let Some(tx) = sender {
        let result = if ok {
            Ok(payload)
        } else {
            Err(payload
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| payload.to_string()))
        };
        let _ = tx.send(result);
    }
    Ok(())
}

/// Frontend → MCP client notification (terax/stopped, terax/crash,
/// terax/run_end), forwarded on every open SSE stream.
#[tauri::command]
pub async fn mcp_notify(
    event: String,
    payload: Value,
    state: State<'_, McpState>,
) -> Result<(), String> {
    let msg = json!({ "jsonrpc": "2.0", "method": event, "params": payload }).to_string();
    state
        .inner
        .sse
        .lock()
        .unwrap()
        .retain(|tx| tx.send(msg.clone()).is_ok());
    Ok(())
}

// --- HTTP server ---

fn accept_loop(
    listener: TcpListener,
    app: AppHandle,
    shared: Arc<Shared>,
    token: String,
    stop: Arc<AtomicBool>,
) {
    for conn in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(stream) = conn else { continue };
        let app = app.clone();
        let shared = shared.clone();
        let token = token.clone();
        thread::spawn(move || {
            let _ = handle_connection(stream, app, shared, token);
        });
    }
}

struct Request {
    method: String,
    path: String,
    authorized: bool,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream, token: &str) -> std::io::Result<Option<Request>> {
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    let mut reader = BufReader::new(stream.try_clone()?);

    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("")
        .to_string();

    let mut content_length = 0usize;
    let mut authorized = false;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            return Ok(None);
        }
        let trimmed = header.trim_end();
        if trimmed.is_empty() {
            break;
        }
        let Some((name, value)) = trimmed.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "content-length" => content_length = value.parse().unwrap_or(0),
            "authorization" => authorized = value == format!("Bearer {token}"),
            _ => {}
        }
    }

    if content_length > MAX_BODY_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "body too large",
        ));
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    Ok(Some(Request {
        method,
        path,
        authorized,
        body,
    }))
}

fn respond(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()
}

fn handle_connection(
    mut stream: TcpStream,
    app: AppHandle,
    shared: Arc<Shared>,
    token: String,
) -> std::io::Result<()> {
    let Some(req) = read_request(&mut stream, &token)? else {
        return Ok(());
    };
    if req.path != "/mcp" {
        return respond(&mut stream, "404 Not Found", "text/plain", b"not found");
    }
    if !req.authorized {
        return respond(
            &mut stream,
            "401 Unauthorized",
            "text/plain",
            b"missing or invalid bearer token",
        );
    }
    match req.method.as_str() {
        "POST" => {
            let parsed: Value = match serde_json::from_slice(&req.body) {
                Ok(v) => v,
                Err(e) => {
                    let err = json!({
                        "jsonrpc": "2.0", "id": null,
                        "error": { "code": -32700, "message": format!("parse error: {e}") }
                    });
                    return respond(
                        &mut stream,
                        "400 Bad Request",
                        "application/json",
                        err.to_string().as_bytes(),
                    );
                }
            };
            let reply = match parsed {
                Value::Array(msgs) => {
                    let replies: Vec<Value> = msgs
                        .into_iter()
                        .filter_map(|m| handle_message(&app, &shared, m))
                        .collect();
                    if replies.is_empty() {
                        None
                    } else {
                        Some(Value::Array(replies))
                    }
                }
                msg => handle_message(&app, &shared, msg),
            };
            match reply {
                Some(v) => respond(
                    &mut stream,
                    "200 OK",
                    "application/json",
                    v.to_string().as_bytes(),
                ),
                // Notifications get acknowledged without a body.
                None => respond(&mut stream, "202 Accepted", "text/plain", b""),
            }
        }
        "GET" => serve_sse(stream, &shared),
        "DELETE" => respond(&mut stream, "200 OK", "text/plain", b""),
        _ => respond(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain",
            b"method not allowed",
        ),
    }
}

/// The streamable-HTTP notification stream: holds the connection and relays
/// everything `mcp_notify` broadcasts.
fn serve_sse(mut stream: TcpStream, shared: &Arc<Shared>) -> std::io::Result<()> {
    let (tx, rx) = mpsc::channel::<String>();
    shared.sse.lock().unwrap().push(tx);
    stream.set_read_timeout(None)?;
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n"
    )?;
    stream.flush()?;
    loop {
        match rx.recv_timeout(SSE_KEEPALIVE) {
            Ok(msg) => {
                write!(stream, "data: {msg}\n\n")?;
                stream.flush()?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                write!(stream, ": keep-alive\n\n")?;
                stream.flush()?;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

// --- JSON-RPC ---

/// Handles one JSON-RPC message; `None` for notifications (no id).
fn handle_message(app: &AppHandle, shared: &Arc<Shared>, msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    let result: Result<Value, (i64, String)> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION),
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "terax-debugger",
                "version": env!("CARGO_PKG_VERSION"),
            },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(app, shared, name, args) {
                Ok(v) => Ok(tool_result(v, false)),
                // Tool-level failures are results with isError, not RPC errors.
                Err(e) => Ok(tool_result(Value::String(e), true)),
            }
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    };

    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err((code, message)) => json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": code, "message": message }
        }),
    })
}

fn tool_result(payload: Value, is_error: bool) -> Value {
    let text = match payload {
        Value::String(s) => s,
        other => serde_json::to_string_pretty(&other).unwrap_or_else(|_| other.to_string()),
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// Bridges one tool call into the registered webview and waits for its reply.
fn call_tool(
    app: &AppHandle,
    shared: &Arc<Shared>,
    tool: &str,
    args: Value,
) -> Result<Value, String> {
    let label = shared
        .window
        .lock()
        .unwrap()
        .clone()
        .ok_or("Terax's debugger bridge is not connected — is the main window open?")?;
    let id = shared.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    shared.pending.lock().unwrap().insert(id, tx);
    let emitted = app.emit_to(
        &label,
        "terax:mcp-request",
        json!({ "id": id, "tool": tool, "args": args }),
    );
    if let Err(e) = emitted {
        shared.pending.lock().unwrap().remove(&id);
        return Err(format!("failed to reach the Terax window: {e}"));
    }
    let outcome = rx.recv_timeout(BRIDGE_TIMEOUT);
    shared.pending.lock().unwrap().remove(&id);
    match outcome {
        Ok(result) => result,
        Err(_) => Err("terax window did not respond within 30s".into()),
    }
}

// --- tool definitions ---

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn tool_definitions() -> Vec<Value> {
    let file_line = json!({
        "file": { "type": "string", "description": "Absolute path of the source file" },
        "line": { "type": "integer", "description": "1-based line number" },
    });
    let mut with_bp_extras = file_line.clone();
    with_bp_extras["condition"] = json!({ "type": "string", "description": "Python expression; the breakpoint only stops when it is truthy (e.g. \"not torch.isfinite(loss)\")" });
    with_bp_extras["hit_condition"] = json!({ "type": "string", "description": "Hit-count filter, e.g. \"5\" (5th hit) or \"% 100\"" });
    let mut with_tp_extras = file_line.clone();
    with_tp_extras["exprs"] = json!({ "type": "array", "items": { "type": "string" }, "description": "Expressions to snapshot on every pass; omit to capture all locals" });
    with_tp_extras["capture"] = json!({ "type": "string", "enum": ["shape", "stats"], "description": "shape = shape/dtype/device only (cheap); stats adds min/max/mean/std/nonfinite (one GPU sync per tensor)" });
    with_tp_extras["hit_condition"] = json!({ "type": "string", "description": "Hit-count filter, e.g. \"% 10\" to snapshot every 10th pass" });

    vec![
        tool(
            "debug_launch",
            "Launch a Python script under the Terax debugger with execution-map tracing. \
             Runs in the Terax window's active workspace: script/root are local paths, or paths on \
             the SSH host when the window is connected to one (WSL is not supported). \
             Fails if a session is already active. The human sees the same session live in the Terax GUI.",
            schema(
                json!({
                    "script": { "type": "string", "description": "Absolute path of the Python script to debug" },
                    "root": { "type": "string", "description": "Project root (defaults to the nearest ancestor with pyproject.toml/requirements.txt/setup.py/.git, else the script's directory). The project venv's interpreter is used when present." },
                    "args": { "type": "array", "items": { "type": "string" }, "description": "Command-line arguments for the script" },
                    "trace": { "type": "boolean", "description": "Build the execution map while running (default true)" },
                }),
                &["script"],
            ),
        ),
        tool("debug_stop", "Terminate the active debug session.", schema(json!({}), &[])),
        tool(
            "debug_status",
            "Current session status: idle/starting/running/paused/ended, the script, and the paused location if any.",
            schema(json!({}), &[]),
        ),
        tool(
            "set_breakpoint",
            "Set (or update) a stopping breakpoint. Idempotent. Works before launch and mid-run. \
             NOTE: probes fire BEFORE their line executes — to inspect `loss`, break on the line AFTER `loss = ...`.",
            schema(with_bp_extras, &["file", "line"]),
        ),
        tool(
            "set_tracepoint",
            "Set (or update) a non-stopping tracepoint that snapshots variables (tensor shape/dtype/device, optionally stats) on every pass. Idempotent; works mid-run. \
             Snapshots are read back with query_snapshots/find_anomalies. \
             NOTE: probes fire BEFORE their line executes — to capture `loss`, place the tracepoint on the line AFTER `loss = ...`.",
            schema(with_tp_extras, &["file", "line"]),
        ),
        tool("remove_probe", "Remove the probe at file:line.", schema(file_line.clone(), &["file", "line"])),
        tool("list_probes", "List all probes (breakpoints and tracepoints).", schema(json!({}), &[])),
        tool(
            "debug_continue",
            "Resume execution (requires paused). Returns the next stop location, or the end of the run.",
            schema(json!({}), &[]),
        ),
        tool("step_over", "Step over the current line (requires paused). Returns the new location.", schema(json!({}), &[])),
        tool("step_into", "Step into the call on the current line (requires paused). Returns the new location.", schema(json!({}), &[])),
        tool("step_out", "Run until the current function returns (requires paused). Returns the new location.", schema(json!({}), &[])),
        tool("debug_pause", "Interrupt the running program at its current position.", schema(json!({}), &[])),
        tool("get_stack", "Stack frames at the pause point, innermost first (requires paused).", schema(json!({}), &[])),
        tool(
            "get_variables",
            "Local variables of a stack frame (requires paused). One line per variable, values truncated.",
            schema(
                json!({ "frame": { "type": "integer", "description": "Frame index from get_stack (default: the selected frame)" } }),
                &[],
            ),
        ),
        tool(
            "evaluate",
            "Evaluate a Python expression in a paused frame (requires paused). \
             WARNING: runs inside the debuggee with full side effects.",
            schema(
                json!({
                    "expression": { "type": "string" },
                    "frame": { "type": "integer", "description": "Frame index (default: the selected frame)" },
                }),
                &["expression"],
            ),
        ),
        tool(
            "list_runs",
            "Past debug runs (the last 20 are persisted to disk): id, script, start time, whether it crashed, \
             and node/snapshot counts. Pass a returned id as `run_id` to query_graph / query_snapshots / \
             find_anomalies / get_crash_report to inspect that run instead of the live session.",
            schema(json!({}), &[]),
        ),
        tool(
            "query_graph",
            "The execution map recorded so far (also available after the run ends): which project functions ran, \
             call structure, hit counts, cumulative time, and the tensor shapes that flowed through them. \
             Nodes flagged `compiled_hint` come from files using torch.compile — calls inside compiled \
             regions emit no trace events, so children may be missing there.",
            schema(
                json!({
                    "run_id": { "type": "string", "description": "Inspect a persisted past run (see list_runs) instead of the live session" },
                }),
                &[],
            ),
        ),
        tool(
            "query_snapshots",
            "Recorded tracepoint snapshots (also available after the run ends). Rows are flagged when values \
             go nonfinite or change shape between consecutive hits.",
            schema(
                json!({
                    "probe_id": { "type": "string", "description": "Restrict to one probe (\"file:line\" as returned by list_probes)" },
                    "last": { "type": "integer", "description": "Only the most recent N rows per probe (default 20)" },
                    "run_id": { "type": "string", "description": "Inspect a persisted past run (see list_runs) instead of the live session" },
                }),
                &[],
            ),
        ),
        tool(
            "find_anomalies",
            "Scan everything recorded (snapshots + the execution map's recent-hit rings) for the first NaN/Inf \
             occurrence and for tensor shape changes. The fastest way to locate where a training run went wrong.",
            schema(
                json!({
                    "run_id": { "type": "string", "description": "Inspect a persisted past run (see list_runs) instead of the live session" },
                }),
                &[],
            ),
        ),
        tool(
            "get_crash_report",
            "The crash report of the last run, if it raised: exception, traceback frames, and each own-code frame's locals.",
            schema(
                json!({
                    "run_id": { "type": "string", "description": "Inspect a persisted past run (see list_runs) instead of the live session" },
                }),
                &[],
            ),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs `read_request` against raw bytes through a real socket pair.
    fn parse(raw: &[u8], token: &str) -> std::io::Result<Option<Request>> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(addr).unwrap();
        client.write_all(raw).unwrap();
        client.flush().unwrap();
        let (mut server, _) = listener.accept().unwrap();
        read_request(&mut server, token)
    }

    #[test]
    fn parses_post_with_auth_and_body() {
        let raw = b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer sekret\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"a\":\"b\\r\\n\"}";
        let req = parse(raw, "sekret").unwrap().unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/mcp");
        assert!(req.authorized);
        assert_eq!(req.body, b"{\"a\":\"b\\r\\n\"}");
    }

    #[test]
    fn rejects_wrong_token_and_strips_query() {
        let raw = b"GET /mcp?x=1 HTTP/1.1\r\nAuthorization: Bearer wrong\r\n\r\n";
        let req = parse(raw, "sekret").unwrap().unwrap();
        assert_eq!(req.method, "GET");
        assert_eq!(req.path, "/mcp");
        assert!(!req.authorized);
        assert!(req.body.is_empty());
    }

    #[test]
    fn missing_auth_header_is_unauthorized() {
        let raw = b"DELETE /mcp HTTP/1.1\r\nHost: x\r\n\r\n";
        let req = parse(raw, "sekret").unwrap().unwrap();
        assert!(!req.authorized);
    }

    #[test]
    fn oversized_body_is_refused() {
        let raw = format!(
            "POST /mcp HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY_BYTES + 1
        );
        assert!(parse(raw.as_bytes(), "t").is_err());
    }

    #[test]
    fn tool_definitions_are_well_formed() {
        let tools = tool_definitions();
        assert_eq!(tools.len(), 20);
        assert!(tools.iter().any(|t| t["name"] == "list_runs"));
        for t in &tools {
            let name = t["name"].as_str().unwrap();
            assert!(!name.is_empty());
            assert!(!t["description"].as_str().unwrap().is_empty());
            let schema = &t["inputSchema"];
            assert_eq!(schema["type"], "object", "{name} schema must be object");
            assert!(schema["properties"].is_object(), "{name} needs properties");
            assert!(schema["required"].is_array(), "{name} needs required");
        }
    }

    #[test]
    fn tokens_are_hex_and_unique() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
