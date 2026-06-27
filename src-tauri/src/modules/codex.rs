use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize, Serialize)]
struct AuthTokens {
    access_token: String,
    refresh_token: String,
    id_token: Option<String>,
    account_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct AuthFile {
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY")]
    openai_api_key: Option<serde_json::Value>,
    last_refresh: Option<String>,
    tokens: AuthTokens,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthStatus {
    logged_in: bool,
    email: Option<String>,
    account_id: Option<String>,
    expires_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexToken {
    access_token: String,
    account_id: String,
}

fn auth_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("auth.json"))
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn jwt_payload(token: &str) -> Option<serde_json::Value> {
    let seg = token.split('.').nth(1)?;
    let pad = (4usize.wrapping_sub(seg.len() % 4)) % 4;
    let mut b64 = seg.replace('-', "+").replace('_', "/");
    b64.push_str(&"=".repeat(pad));
    let bytes = base64_decode_std(&b64)?;
    serde_json::from_slice(&bytes).ok()
}

fn base64_decode_std(s: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;
    for &b in s.as_bytes() {
        if b == b'=' {
            break;
        }
        let val = TABLE.iter().position(|&t| t == b)? as u32;
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[tauri::command]
pub async fn codex_auth_status() -> Result<CodexAuthStatus, String> {
    let absent = CodexAuthStatus {
        logged_in: false,
        email: None,
        account_id: None,
        expires_at: None,
    };
    let Some(path) = auth_path() else {
        return Ok(absent);
    };
    if !path.exists() {
        return Ok(absent);
    }

    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let auth: AuthFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    let access_payload = jwt_payload(&auth.tokens.access_token);
    let exp = access_payload.as_ref().and_then(|p| p["exp"].as_i64());

    // Email lives in id_token payload; fall back to access_token payload.
    let email = auth
        .tokens
        .id_token
        .as_deref()
        .and_then(jwt_payload)
        .and_then(|p| p["email"].as_str().map(String::from))
        .or_else(|| {
            access_payload
                .as_ref()
                .and_then(|p| p["email"].as_str().map(String::from))
        });

    let logged_in = exp.map(|e| e > now_secs() + 60).unwrap_or(false);

    Ok(CodexAuthStatus {
        logged_in,
        email,
        account_id: auth.tokens.account_id.clone(),
        expires_at: exp,
    })
}

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_MARGIN_SECS: i64 = 300; // refresh when < 5 min remain
const CODEX_BASE: &str = "https://chatgpt.com/backend-api/codex";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub slug: String,
    pub display_name: String,
    pub description: String,
    pub context_window: u64,
    pub input_modalities: Vec<String>,
    pub supports_parallel_tool_calls: bool,
}

#[tauri::command]
pub async fn codex_list_models() -> Result<Vec<CodexModel>, String> {
    let token = codex_get_access_token().await?;

    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .get(format!("{CODEX_BASE}/models?client_version=0.1.0"))
        .header("Authorization", format!("Bearer {}", token.access_token))
        .header("chatgpt-account-id", token.account_id)
        .header("originator", "terax")
        .send()
        .await
        .map_err(|e| format!("models request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("models response malformed: {e}"))?;

    let models = resp["models"]
        .as_array()
        .ok_or("unexpected models response format")?
        .iter()
        .filter_map(|m| {
            Some(CodexModel {
                slug: m["slug"].as_str()?.to_string(),
                display_name: m["display_name"].as_str()?.to_string(),
                description: m
                    .get("description")
                    .and_then(|d| d.as_str())
                    .unwrap_or("")
                    .to_string(),
                context_window: m["context_window"].as_u64().unwrap_or(128_000),
                input_modalities: m["input_modalities"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
                supports_parallel_tool_calls: m["supports_parallel_tool_calls"]
                    .as_bool()
                    .unwrap_or(false),
            })
        })
        .collect();

    Ok(models)
}

#[tauri::command]
pub async fn codex_get_access_token() -> Result<CodexToken, String> {
    let path = auth_path().ok_or("cannot locate home directory")?;

    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read ~/.codex/auth.json: {e}"))?;
    let mut auth: AuthFile =
        serde_json::from_str(&raw).map_err(|e| format!("malformed auth.json: {e}"))?;

    let exp = jwt_payload(&auth.tokens.access_token)
        .and_then(|p| p["exp"].as_i64())
        .unwrap_or(0);

    if exp - now_secs() < REFRESH_MARGIN_SECS {
        let client = reqwest::Client::new();
        let body: serde_json::Value = client
            .post("https://auth.openai.com/oauth/token")
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "grant_type": "refresh_token",
                "client_id": CLIENT_ID,
                "refresh_token": &auth.tokens.refresh_token,
                "scope": "openid profile email offline_access",
            }))
            .send()
            .await
            .map_err(|e| format!("refresh request failed: {e}"))?
            .json()
            .await
            .map_err(|e| format!("refresh response malformed: {e}"))?;

        if body.get("error").is_some() {
            return Err(format!(
                "Token refresh failed: {}. Run `pnpm dlx @openai/codex login` to re-authenticate.",
                body["error"]
            ));
        }

        if let Some(at) = body["access_token"].as_str() {
            auth.tokens.access_token = at.to_string();
        }
        if let Some(rt) = body["refresh_token"].as_str() {
            auth.tokens.refresh_token = rt.to_string();
        }
        if let Some(it) = body["id_token"].as_str() {
            auth.tokens.id_token = Some(it.to_string());
        }

        let tmp = path.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_string_pretty(&auth).map_err(|e| format!("serialize: {e}"))?,
        )
        .map_err(|e| format!("write tmp: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    }

    let account_id = auth.tokens.account_id.unwrap_or_else(|| {
        jwt_payload(&auth.tokens.access_token)
            .and_then(|p| {
                p["https://api.openai.com/auth"]["chatgpt_account_id"]
                    .as_str()
                    .map(String::from)
            })
            .unwrap_or_default()
    });

    Ok(CodexToken {
        access_token: auth.tokens.access_token,
        account_id,
    })
}
