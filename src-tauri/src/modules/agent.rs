use serde_json::{json, Value};

const HOOK_EVENTS: [(&str, &str); 3] = [
    ("UserPromptSubmit", "working"),
    ("Notification", "attention"),
    ("Stop", "finished"),
];

// Includes the pre-v2.1.139 /dev/tty variant so re-running migrates it.
const OWNED_MARKERS: [&str; 2] = ["notify;Terax;", "terax;notify"];

// Gated on TERAX_TERMINAL; no-op outside Terax. Returns the sequence via
// `terminalSequence` because hooks lost /dev/tty access in v2.1.139.
// The payload is printf's argument, never its format: as a format, bash
// expands `\u001b`/`\u0007` into raw ESC/BEL, which is invalid inside a JSON
// string. Claude Code decodes the escapes before writing to the terminal.
// Must stay byte-identical to `hook_cmd` in ssh/mod.rs's remote installer.
fn hook_cmd(event: &str) -> String {
    format!(
        r#"[ -n "$TERAX_TERMINAL" ] && printf %s '{{"terminalSequence":"\u001b]777;notify;Terax;{event}\u0007"}}' || true"#
    )
}

fn is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| OWNED_MARKERS.iter().any(|m| c.contains(m)))
            })
        })
}

// A group with no hooks is inert cruft (e.g. left behind when someone deletes
// our command but not its wrapper). Drop it so the file stays clean.
fn is_empty_group(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_none_or(|hs| hs.is_empty())
}

fn merge_hooks(mut root: Value) -> Value {
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();

    for (event, marker) in HOOK_EVENTS {
        let arr = hooks.entry(event).or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let arr = arr.as_array_mut().unwrap();
        arr.retain(|group| !is_ours(group) && !is_empty_group(group));
        arr.push(json!({
            "hooks": [ { "type": "command", "command": hook_cmd(marker) } ]
        }));
    }
    root
}

// True when some owned hook is not the current command (e.g. the pre-fix
// printf-format variant), so an already-opted-in user gets migrated.
fn has_stale_hooks(root: &Value) -> bool {
    let Some(hooks) = root.get("hooks").and_then(Value::as_object) else {
        return false;
    };
    let current: Vec<String> = HOOK_EVENTS.iter().map(|(_, m)| hook_cmd(m)).collect();
    hooks
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .any(|group| {
            is_ours(group)
                && group["hooks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|h| h.get("command").and_then(Value::as_str))
                    .any(|c| !current.iter().any(|cur| cur == c))
        })
}

/// Merges our hooks into a settings.json body (None = file absent) and returns
/// the new body. Used by the SSH installer for Windows remotes, whose
/// PowerShell 5.1 can't round-trip JSON faithfully.
pub(crate) fn merged_settings_text(
    contents: Option<&str>,
    path: &std::path::Path,
) -> Result<String, String> {
    let merged = merge_hooks(existing_config(contents, path)?);
    serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())
}

fn existing_config(contents: Option<&str>, path: &std::path::Path) -> Result<Value, String> {
    // Windows editors often save settings.json with a UTF-8 BOM.
    let contents = contents.map(|s| s.trim_start_matches('\u{feff}'));
    match contents {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Value>(s).map_err(|e| {
            format!(
                "{} is not valid JSON ({e}); refusing to overwrite",
                path.display()
            )
        }),
        _ => Ok(json!({})),
    }
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(".claude")
        .join("settings.json"))
}

#[tauri::command]
pub fn agent_enable_claude_hooks() -> Result<(), String> {
    install_hooks(false)
}

/// Run at startup: rewrites our hooks only if the user already installed them
/// and they are outdated. Never adds hooks for users who didn't opt in.
pub fn upgrade_stale_claude_hooks() {
    if let Err(e) = install_hooks(true) {
        eprintln!("terax: claude hook upgrade skipped: {e}");
    }
}

fn install_hooks(only_if_stale: bool) -> Result<(), String> {
    let path = settings_path()?;
    let dir = path.parent().unwrap();

    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => existing_config(Some(&s), &path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    if only_if_stale && !has_stale_hooks(&existing) {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let merged = merge_hooks(existing);
    let out = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;

    // Write to a sibling temp file then rename so a crash mid-write can't leave
    // a truncated settings.json.
    let tmp = path.with_extension("json.terax-tmp");
    std::fs::write(&tmp, out).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename into {}: {e}", path.display())
    })?;
    Ok(())
}

#[tauri::command]
pub fn agent_claude_hooks_status() -> bool {
    let Some(content) = settings_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
    else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<Value>(&content) else {
        return false;
    };
    HOOK_EVENTS.iter().all(|(event, m)| {
        let want = hook_cmd(m);
        root["hooks"][event].as_array().is_some_and(|groups| {
            groups.iter().any(|g| {
                g["hooks"].as_array().is_some_and(|hs| {
                    hs.iter()
                        .any(|h| h["command"].as_str() == Some(want.as_str()))
                })
            })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook_count(root: &Value, event: &str) -> usize {
        root["hooks"][event].as_array().map_or(0, Vec::len)
    }

    fn command(root: &Value, event: &str, idx: usize) -> String {
        root["hooks"][event][idx]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn adds_all_event_hooks_to_empty_config() {
        let out = merge_hooks(json!({}));
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 1);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert_eq!(hook_count(&out, "Stop"), 1);
        assert!(command(&out, "Notification", 0).contains("notify;Terax;attention"));
        assert!(command(&out, "Stop", 0).contains("notify;Terax;finished"));
        assert!(command(&out, "UserPromptSubmit", 0).contains("notify;Terax;working"));
        assert!(command(&out, "Stop", 0).contains("terminalSequence"));
        assert!(!command(&out, "Stop", 0).contains("/dev/tty"));
    }

    #[test]
    fn is_idempotent() {
        let once = merge_hooks(json!({}));
        let twice = merge_hooks(once.clone());
        assert_eq!(once, twice);
        assert_eq!(hook_count(&twice, "Notification"), 1);
    }

    #[test]
    fn migrates_legacy_dev_tty_hook() {
        let legacy = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [ {
                        "type": "command",
                        "command": "[ -n \"$TERAX_TERMINAL\" ] && printf '\\033]777;terax;notify\\033\\\\' > /dev/tty || true"
                    } ] }
                ]
            }
        });
        let out = merge_hooks(legacy);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("terminalSequence"));
        assert!(!command(&out, "Notification", 0).contains("/dev/tty"));
    }

    // Pre-fix template: the JSON payload was printf's format string.
    const BROKEN_STOP: &str = r#"[ -n "$TERAX_TERMINAL" ] && printf '{"terminalSequence":"\u001b]777;notify;Terax;finished\u0007"}' || true"#;

    #[test]
    fn migrates_broken_printf_format_hook() {
        let legacy = json!({
            "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": BROKEN_STOP } ] } ] }
        });
        assert!(has_stale_hooks(&legacy));
        let out = merge_hooks(legacy);
        assert_eq!(hook_count(&out, "Stop"), 1);
        assert_eq!(command(&out, "Stop", 0), hook_cmd("finished"));
        assert!(!has_stale_hooks(&out));
    }

    #[test]
    fn current_or_foreign_hooks_are_not_stale() {
        assert!(!has_stale_hooks(&json!({})));
        assert!(!has_stale_hooks(&merge_hooks(json!({}))));
        assert!(!has_stale_hooks(&json!({
            "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "say hi" } ] } ] }
        })));
    }

    // Runs each hook through real shells and checks stdout is valid JSON whose
    // decoded terminalSequence is the OSC 777 notify sequence (ESC ... BEL).
    #[test]
    #[cfg(unix)]
    fn hook_output_is_valid_json_in_every_shell() {
        // zsh and bash>=4 expand \u in a format string; macOS /bin/bash 3.2 does not.
        for shell in ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash"] {
            if !std::path::Path::new(shell).exists() {
                continue;
            }
            for (_, m) in HOOK_EVENTS {
                let out = std::process::Command::new(shell)
                    .arg("-c")
                    .arg(hook_cmd(m))
                    .env("TERAX_TERMINAL", "1")
                    .output()
                    .unwrap();
                let v: Value = serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
                    panic!("{shell} {m}: invalid JSON ({e}): {:?}", out.stdout)
                });
                assert_eq!(
                    v["terminalSequence"].as_str().unwrap(),
                    format!("\x1b]777;notify;Terax;{m}\x07")
                );
            }
            // Outside Terax: no output, exit 0.
            let out = std::process::Command::new(shell)
                .arg("-c")
                .arg(hook_cmd("finished"))
                .env_remove("TERAX_TERMINAL")
                .output()
                .unwrap();
            assert!(out.status.success() && out.stdout.is_empty());
        }
    }

    #[test]
    fn preserves_unrelated_settings_and_foreign_hooks() {
        let input = json!({
            "permissions": { "allow": ["Bash"] },
            "hooks": {
                "Notification": [
                    { "hooks": [ { "type": "command", "command": "say hi" } ] }
                ]
            }
        });
        let out = merge_hooks(input);
        assert_eq!(out["permissions"]["allow"][0], "Bash");
        assert_eq!(hook_count(&out, "Notification"), 2);
        assert_eq!(command(&out, "Notification", 0), "say hi");
    }

    #[test]
    fn replaces_non_object_root() {
        let out = merge_hooks(json!("garbage"));
        assert_eq!(hook_count(&out, "Notification"), 1);
    }

    #[test]
    fn prunes_empty_groups_and_collapses_duplicates() {
        let input = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [] },
                    { "hooks": [ { "type": "command", "command": hook_cmd("attention") } ] }
                ]
            }
        });
        let out = merge_hooks(input);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("notify;Terax;attention"));
    }

    #[test]
    fn existing_config_absent_or_empty_starts_fresh() {
        let p = std::path::Path::new("/x/settings.json");
        assert_eq!(existing_config(None, p).unwrap(), json!({}));
        assert_eq!(existing_config(Some("   \n"), p).unwrap(), json!({}));
    }

    #[test]
    fn existing_config_refuses_to_clobber_invalid_json() {
        let p = std::path::Path::new("/x/settings.json");
        assert!(existing_config(Some("{ not json,"), p).is_err());
        assert_eq!(
            existing_config(Some(r#"{"permissions":{}}"#), p).unwrap(),
            json!({ "permissions": {} })
        );
    }

    #[test]
    fn merged_settings_text_handles_bom_and_keeps_foreign_settings() {
        let p = std::path::Path::new("C:/x/settings.json");
        let out = merged_settings_text(Some("\u{feff}{\"model\":\"opus\"}"), p).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], "opus");
        assert_eq!(command(&v, "Stop", 0), hook_cmd("finished"));
        assert!(merged_settings_text(Some("{ broken"), p).is_err());
    }
}
