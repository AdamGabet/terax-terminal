//! Remote filesystem operations: each mirrors a local `fs::*` command and
//! returns the same response struct, so the Tauri commands can branch on
//! `WorkspaceEnv::Ssh` with a one-line delegation.

use serde_json::{json, Value};

use super::agent::{DEFAULT_TIMEOUT, SLOW_TIMEOUT};
use super::registry;
use crate::modules::fs::file::{FileStat, ReadBinaryResult, ReadResult, StatKind};
use crate::modules::fs::grep::{GlobHit, GlobResponse, GrepHit, GrepResponse};
use crate::modules::fs::search::{ListFilesResult, SearchHit, SearchResult};
use crate::modules::fs::tree::{DirEntry, EntryKind};

fn request(host: &str, op: &str, params: Value) -> Result<Value, String> {
    registry()
        .connection(host)?
        .agent()?
        .request(op, params, DEFAULT_TIMEOUT)
}

fn request_slow(host: &str, op: &str, params: Value) -> Result<Value, String> {
    registry()
        .connection(host)?
        .agent()?
        .request(op, params, SLOW_TIMEOUT)
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn u64_field(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn bool_field(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn arr(v: &Value, key: &str) -> Vec<Value> {
    v.get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn entry_kind(s: &str) -> EntryKind {
    match s {
        "dir" => EntryKind::Dir,
        "symlink" => EntryKind::Symlink,
        _ => EntryKind::File,
    }
}

pub fn read_dir(host: &str, path: &str, show_hidden: bool) -> Result<Vec<DirEntry>, String> {
    let data = request(
        host,
        "read_dir",
        json!({"path": path, "show_hidden": show_hidden}),
    )?;
    let entries = data
        .as_array()
        .ok_or("malformed read_dir reply")?
        .iter()
        .map(|e| DirEntry {
            name: str_field(e, "name"),
            kind: entry_kind(&str_field(e, "kind")),
            size: u64_field(e, "size"),
            mtime: u64_field(e, "mtime"),
        })
        .collect();
    Ok(entries)
}

pub fn list_subdirs(host: &str, path: &str, show_hidden: bool) -> Result<Vec<String>, String> {
    let data = request(
        host,
        "list_subdirs",
        json!({"path": path, "show_hidden": show_hidden}),
    )?;
    Ok(data
        .as_array()
        .ok_or("malformed list_subdirs reply")?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect())
}

pub fn read_file(host: &str, path: &str, limit: u64) -> Result<ReadResult, String> {
    let data = request_slow(host, "read_file", json!({"path": path, "limit": limit}))?;
    let size = u64_field(&data, "size");
    match str_field(&data, "kind").as_str() {
        "text" => Ok(ReadResult::Text {
            content: str_field(&data, "content"),
            size,
        }),
        "binary" => Ok(ReadResult::Binary { size }),
        "toolarge" => Ok(ReadResult::TooLarge {
            size,
            limit: u64_field(&data, "limit"),
        }),
        other => Err(format!("malformed read_file reply: {other}")),
    }
}

pub fn read_file_base64(host: &str, path: &str, limit: u64) -> Result<ReadBinaryResult, String> {
    let data = request_slow(host, "read_file_b64", json!({"path": path, "limit": limit}))?;
    let size = u64_field(&data, "size");
    match str_field(&data, "kind").as_str() {
        "data" => Ok(ReadBinaryResult::Data {
            base64: str_field(&data, "base64"),
            size,
        }),
        "toolarge" => Ok(ReadBinaryResult::TooLarge {
            size,
            limit: u64_field(&data, "limit"),
        }),
        other => Err(format!("malformed read_file_b64 reply: {other}")),
    }
}

/// Text read for git diffs; size-capped like the local `read_text_file`.
pub fn read_text(host: &str, path: &str, limit: u64) -> Result<Option<String>, String> {
    match read_file(host, path, limit) {
        Ok(ReadResult::Text { content, .. }) => Ok(Some(content)),
        Ok(_) => Ok(None),
        Err(e) if e.contains("No such file") || e.contains("not found") => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn write_file(host: &str, path: &str, content: &str) -> Result<(), String> {
    request_slow(
        host,
        "write_file",
        json!({"path": path, "content": content}),
    )?;
    Ok(())
}

pub fn stat(host: &str, path: &str) -> Result<FileStat, String> {
    let data = request(host, "stat", json!({"path": path}))?;
    let kind = match str_field(&data, "kind").as_str() {
        "dir" => StatKind::Dir,
        "symlink" => StatKind::Symlink,
        _ => StatKind::File,
    };
    Ok(FileStat {
        size: u64_field(&data, "size"),
        mtime: u64_field(&data, "mtime"),
        kind,
    })
}

pub fn canonicalize(host: &str, path: &str) -> Result<String, String> {
    let data = request(host, "canonicalize", json!({"path": path}))?;
    data.as_str()
        .map(str::to_string)
        .ok_or_else(|| "malformed canonicalize reply".into())
}

pub fn create_file(host: &str, path: &str) -> Result<(), String> {
    request(host, "create_file", json!({"path": path}))?;
    Ok(())
}

pub fn create_dir(host: &str, path: &str) -> Result<(), String> {
    request(host, "create_dir", json!({"path": path}))?;
    Ok(())
}

pub fn rename(host: &str, from: &str, to: &str) -> Result<(), String> {
    request(host, "rename", json!({"from": from, "to": to}))?;
    Ok(())
}

pub fn delete(host: &str, path: &str) -> Result<(), String> {
    request(host, "delete", json!({"path": path}))?;
    Ok(())
}

pub fn search(
    host: &str,
    root: &str,
    query: &str,
    limit: usize,
    show_hidden: bool,
) -> Result<SearchResult, String> {
    let data = request_slow(
        host,
        "search",
        json!({"root": root, "query": query, "limit": limit, "show_hidden": show_hidden}),
    )?;
    let hits = arr(&data, "hits")
        .iter()
        .map(|h| SearchHit {
            path: str_field(h, "path"),
            rel: str_field(h, "rel"),
            name: str_field(h, "name"),
            is_dir: bool_field(h, "is_dir"),
        })
        .collect();
    Ok(SearchResult {
        hits,
        truncated: bool_field(&data, "truncated"),
    })
}

pub fn list_files(
    host: &str,
    root: &str,
    limit: usize,
    max_depth: usize,
    show_hidden: bool,
) -> Result<ListFilesResult, String> {
    let data = request_slow(
        host,
        "list_files",
        json!({"root": root, "limit": limit, "max_depth": max_depth, "show_hidden": show_hidden}),
    )?;
    Ok(ListFilesResult {
        files: arr(&data, "files")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        truncated: bool_field(&data, "truncated"),
    })
}

pub fn grep(
    host: &str,
    pattern: &str,
    root: &str,
    globs: &[String],
    case_insensitive: bool,
    max_results: usize,
) -> Result<GrepResponse, String> {
    let data = request_slow(
        host,
        "grep",
        json!({
            "pattern": pattern,
            "root": root,
            "globs": globs,
            "case_insensitive": case_insensitive,
            "max_results": max_results,
        }),
    )?;
    let hits = arr(&data, "hits")
        .iter()
        .map(|h| GrepHit {
            path: str_field(h, "path"),
            rel: str_field(h, "rel"),
            line: u64_field(h, "line"),
            text: str_field(h, "text"),
        })
        .collect();
    Ok(GrepResponse {
        hits,
        truncated: bool_field(&data, "truncated"),
        files_scanned: u64_field(&data, "files_scanned") as usize,
    })
}

pub fn glob(
    host: &str,
    pattern: &str,
    root: &str,
    max_results: usize,
) -> Result<GlobResponse, String> {
    let data = request_slow(
        host,
        "glob",
        json!({"pattern": pattern, "root": root, "max_results": max_results}),
    )?;
    let hits = arr(&data, "hits")
        .iter()
        .map(|h| GlobHit {
            path: str_field(h, "path"),
            rel: str_field(h, "rel"),
        })
        .collect();
    Ok(GlobResponse {
        hits,
        truncated: bool_field(&data, "truncated"),
    })
}

pub fn watch_add(host: &str, paths: &[String]) -> Result<(), String> {
    request(host, "watch_add", json!({"paths": paths}))?;
    Ok(())
}

pub fn watch_remove(host: &str, paths: &[String]) -> Result<(), String> {
    request(host, "watch_remove", json!({"paths": paths}))?;
    Ok(())
}
