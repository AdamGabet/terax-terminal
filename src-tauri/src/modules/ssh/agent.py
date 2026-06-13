#!/usr/bin/env python3
"""Terax remote agent.

Installed by Terax at ~/.cache/terax/remote/agent.py and run over a
multiplexed SSH channel. Speaks JSON-lines on stdin/stdout:

  request:  {"id": N, "op": "...", ...params}
  response: {"id": N, "ok": true, "data": ...} | {"id": N, "ok": false, "error": "..."}
  event:    {"event": "fs_changed", "paths": [...]}

Requires only the Python 3 standard library (3.6+).
"""

import base64
import json
import os
import re
import shutil
import stat as statmod
import sys
import threading
import time

AGENT_VERSION = 4

BINARY_SNIFF_BYTES = 8 * 1024
WATCH_POLL_SECS = 2.0

PRUNE_DIRS = {
    "node_modules", ".git", "target", "dist", "build", ".next", ".turbo",
    ".cache", ".venv", "__pycache__",
}

_write_lock = threading.Lock()


def send(obj):
    line = json.dumps(obj, separators=(",", ":"))
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def norm(path):
    return os.path.expanduser(path)


# ---------------------------------------------------------------------------
# gitignore-lite: enough pattern support for typical repos (*, ?, **, anchors,
# dir-only, negation). Patterns apply relative to the directory holding the
# .gitignore file.
# ---------------------------------------------------------------------------

def _glob_to_regex(pat):
    out = []
    i = 0
    n = len(pat)
    while i < n:
        c = pat[i]
        if c == "*":
            if pat[i:i + 3] == "**/":
                out.append("(?:.*/)?")
                i += 3
                continue
            if pat[i:i + 2] == "**":
                out.append(".*")
                i += 2
                continue
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        elif c == "[":
            j = i + 1
            if j < n and pat[j] in "!^":
                j += 1
            if j < n and pat[j] == "]":
                j += 1
            while j < n and pat[j] != "]":
                j += 1
            if j < n:
                inner = pat[i + 1:j].replace("\\", "\\\\")
                if inner.startswith("!"):
                    inner = "^" + inner[1:]
                out.append("[" + inner + "]")
                i = j
            else:
                out.append("\\[")
        else:
            out.append(re.escape(c))
        i += 1
    return "".join(out)


class IgnoreRule(object):
    __slots__ = ("regex", "negate", "dir_only")

    def __init__(self, pattern):
        self.negate = pattern.startswith("!")
        if self.negate:
            pattern = pattern[1:]
        self.dir_only = pattern.endswith("/")
        pattern = pattern.rstrip("/")
        anchored = "/" in pattern[:-1] or pattern.startswith("/")
        pattern = pattern.lstrip("/")
        body = _glob_to_regex(pattern)
        if anchored:
            self.regex = re.compile("^" + body + "(?:/|$)")
        else:
            self.regex = re.compile("(?:^|/)" + body + "(?:/|$)")

    def matches(self, rel, is_dir):
        if self.dir_only and not is_dir:
            return False
        return self.regex.search(rel) is not None


def load_ignore_rules(dirpath):
    rules = []
    try:
        with open(os.path.join(dirpath, ".gitignore"), "r", errors="replace") as f:
            for line in f:
                line = line.rstrip("\n").rstrip("\r")
                if not line or line.lstrip().startswith("#"):
                    continue
                line = line.strip()
                if line:
                    try:
                        rules.append(IgnoreRule(line))
                    except re.error:
                        pass
    except OSError:
        pass
    return rules


def is_ignored(rel, is_dir, rule_stack):
    # Last matching rule wins, deeper .gitignore files take precedence.
    verdict = False
    for base_rel, rules in rule_stack:
        if base_rel:
            if not rel.startswith(base_rel + "/"):
                continue
            sub = rel[len(base_rel) + 1:]
        else:
            sub = rel
        for rule in rules:
            if rule.matches(sub, is_dir):
                verdict = not rule.negate
    return verdict


def walk_tree(root, show_hidden, max_depth, max_scanned):
    """Yields (abspath, rel, is_dir). Prunes heavy dirs, honors .gitignore."""
    state = {"scanned": 0, "truncated": False}
    root = os.path.realpath(root)

    def rec(dirpath, rel_base, depth, rule_stack):
        if state["truncated"]:
            return
        rules = load_ignore_rules(dirpath)
        if rules:
            rule_stack = rule_stack + [(rel_base, rules)]
        try:
            entries = sorted(os.scandir(dirpath), key=lambda e: e.name)
        except OSError:
            return
        for entry in entries:
            if state["truncated"]:
                return
            state["scanned"] += 1
            if state["scanned"] > max_scanned:
                state["truncated"] = True
                return
            name = entry.name
            if not show_hidden and name.startswith("."):
                continue
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            rel = rel_base + "/" + name if rel_base else name
            if is_dir and name in PRUNE_DIRS:
                continue
            if is_ignored(rel, is_dir, rule_stack):
                continue
            yield entry.path, rel, is_dir
            if is_dir and depth < max_depth:
                for item in rec(entry.path, rel, depth + 1, rule_stack):
                    yield item

    gen = rec(root, "", 1, [])
    return gen, state


# ---------------------------------------------------------------------------
# ops
# ---------------------------------------------------------------------------

def op_hello(req):
    return {"version": AGENT_VERSION, "home": os.path.expanduser("~")}


def _entry_info(path):
    """(kind, size, mtime_ms) following symlinks; broken symlink -> symlink."""
    try:
        st = os.stat(path)
        was_symlink = False
    except OSError:
        st = os.lstat(path)
        was_symlink = True
    if was_symlink:
        kind = "symlink"
    elif statmod.S_ISDIR(st.st_mode):
        kind = "dir"
    else:
        kind = "file"
    return kind, st.st_size, int(st.st_mtime * 1000)


def op_read_dir(req):
    root = norm(req["path"])
    show_hidden = bool(req.get("show_hidden"))
    out = []
    for entry in os.scandir(root):
        name = entry.name
        if name.startswith(".") and not show_hidden:
            continue
        try:
            kind, size, mtime = _entry_info(entry.path)
        except OSError:
            continue
        out.append({"name": name, "kind": kind, "size": size, "mtime": mtime})
    rank = {"dir": 0, "symlink": 1, "file": 2}
    out.sort(key=lambda e: (rank[e["kind"]], e["name"].lower()))
    return out


def op_list_subdirs(req):
    root = norm(req["path"])
    show_hidden = bool(req.get("show_hidden"))
    dirs = []
    for entry in os.scandir(root):
        name = entry.name
        if name.startswith(".") and not show_hidden:
            continue
        try:
            if entry.is_dir(follow_symlinks=True):
                dirs.append(name)
        except OSError:
            continue
    dirs.sort(key=lambda s: s.lower())
    return dirs


def _classify_bytes(data):
    sniff = data[:BINARY_SNIFF_BYTES]
    if b"\x00" in sniff:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def op_read_file(req):
    path = norm(req["path"])
    limit = int(req.get("limit", 10 * 1024 * 1024))
    size = os.stat(path).st_size
    if size > limit:
        return {"kind": "toolarge", "size": size, "limit": limit}
    with open(path, "rb") as f:
        data = f.read()
    text = _classify_bytes(data)
    if text is None:
        return {"kind": "binary", "size": size}
    return {"kind": "text", "content": text, "size": size}


def op_read_file_b64(req):
    path = norm(req["path"])
    limit = int(req.get("limit", 50 * 1024 * 1024))
    size = os.stat(path).st_size
    if size > limit:
        return {"kind": "toolarge", "size": size, "limit": limit}
    with open(path, "rb") as f:
        data = f.read()
    return {"kind": "data", "base64": base64.b64encode(data).decode("ascii"), "size": size}


def op_write_file_b64(req):
    """Binary write (e.g. a clipboard image pasted into a remote terminal)."""
    path = norm(req["path"])
    data = base64.b64decode(req["base64"])
    parent = os.path.dirname(path) or "."
    if not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    tmp = os.path.join(parent, ".terax-%d-%d.tmp" % (os.getpid(), threading.get_ident()))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return None


def op_write_file(req):
    path = norm(req["path"])
    data = req["content"].encode("utf-8")
    parent = os.path.dirname(path) or "."
    mode = None
    try:
        mode = statmod.S_IMODE(os.stat(path).st_mode)
    except OSError:
        pass
    tmp = os.path.join(parent, ".terax-%d-%d.tmp" % (os.getpid(), threading.get_ident()))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    if mode is not None:
        try:
            os.chmod(path, mode)
        except OSError:
            pass
    return None


def op_stat(req):
    path = norm(req["path"])
    kind, size, mtime = _entry_info(path)
    return {"size": size, "mtime": mtime, "kind": kind}


def op_canonicalize(req):
    path = norm(req["path"])
    real = os.path.realpath(path)
    if not os.path.exists(real):
        raise OSError("no such file or directory: %s" % path)
    return real


def op_create_file(req):
    path = norm(req["path"])
    if os.path.lexists(path):
        raise OSError("already exists: %s" % path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    os.close(fd)
    return None


def op_create_dir(req):
    path = norm(req["path"])
    if os.path.lexists(path):
        raise OSError("already exists: %s" % path)
    os.makedirs(path)
    return None


def op_rename(req):
    src = norm(req["from"])
    dst = norm(req["to"])
    if not os.path.lexists(src):
        raise OSError("not found: %s" % src)
    if os.path.lexists(dst):
        raise OSError("already exists: %s" % dst)
    os.rename(src, dst)
    return None


def op_delete(req):
    path = norm(req["path"])
    st = os.lstat(path)
    if statmod.S_ISDIR(st.st_mode):
        shutil.rmtree(path)
    else:
        os.unlink(path)
    return None


def op_pty_cwd(req):
    """Current cwd of the shell behind a Terax SSH terminal.

    The PTY bootstrap script writes its PID to pty-<token>.pid before exec'ing
    the user's shell (same PID). Works for ANY shell — no OSC 7 integration
    needed — as long as the host has /proc (Linux).
    """
    token = str(req["token"])
    if not re.match(r"^[A-Za-z0-9._-]{1,64}$", token):
        raise ValueError("bad token")
    pidfile = os.path.expanduser("~/.cache/terax/remote/pty-%s.pid" % token)
    with open(pidfile, "r") as f:
        pid = int(f.read().strip())
    return os.readlink("/proc/%d/cwd" % pid)


def op_search(req):
    root = norm(req["root"])
    query = req["query"].strip().lower()
    cap = int(req.get("limit", 200))
    show_hidden = bool(req.get("show_hidden"))
    if not query:
        return {"hits": [], "truncated": False}
    if not os.path.isdir(root):
        raise OSError("not a directory: %s" % req["root"])
    hits = []
    gen, state = walk_tree(root, show_hidden, 64, 50000)
    truncated = False
    for path, rel, is_dir in gen:
        if len(hits) >= cap:
            truncated = True
            break
        if query in rel.lower():
            hits.append({
                "path": path,
                "rel": rel,
                "name": os.path.basename(path),
                "is_dir": is_dir,
            })
    truncated = truncated or state["truncated"]
    hits.sort(key=lambda h: (query not in h["name"].lower(), len(h["rel"])))
    return {"hits": hits, "truncated": truncated}


def op_list_files(req):
    root = norm(req["root"])
    cap = int(req.get("limit", 2000))
    max_depth = int(req.get("max_depth", 8))
    show_hidden = bool(req.get("show_hidden"))
    if not os.path.isdir(root):
        raise OSError("not a directory: %s" % req["root"])
    files = []
    gen, state = walk_tree(root, show_hidden, max_depth, 50000)
    truncated = False
    for path, rel, is_dir in gen:
        if is_dir:
            continue
        files.append(rel)
        if len(files) >= cap:
            truncated = True
            break
    truncated = truncated or state["truncated"]
    files.sort(key=lambda s: s.lower())
    return {"files": files, "truncated": truncated}


def op_grep(req):
    root = norm(req["root"])
    cap = int(req.get("max_results", 200))
    flags = re.IGNORECASE if req.get("case_insensitive") else 0
    try:
        pattern = re.compile(req["pattern"], flags)
    except re.error as e:
        raise ValueError("bad regex: %s" % e)
    globs = [re.compile("^" + _glob_to_regex(g) + "$") for g in (req.get("globs") or [])]
    if not os.path.isdir(root):
        raise OSError("not a directory: %s" % req["root"])

    hits = []
    files_scanned = 0
    truncated = False
    gen, _state = walk_tree(root, False, 64, 200000)
    for path, rel, is_dir in gen:
        if truncated:
            break
        if is_dir:
            continue
        if globs and not any(g.match(rel) for g in globs):
            continue
        try:
            if os.stat(path).st_size > 5 * 1024 * 1024:
                continue
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            continue
        if b"\x00" in data[:BINARY_SNIFF_BYTES]:
            continue
        files_scanned += 1
        try:
            text = data.decode("utf-8", errors="replace")
        except Exception:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if pattern.search(line):
                if len(hits) >= cap:
                    truncated = True
                    break
                hits.append({"path": path, "rel": rel, "line": lineno, "text": line})
    return {"hits": hits, "truncated": truncated, "files_scanned": files_scanned}


def op_glob(req):
    root = norm(req["root"])
    cap = int(req.get("max_results", 500))
    matcher = re.compile("^" + _glob_to_regex(req["pattern"]) + "$")
    if not os.path.isdir(root):
        raise OSError("not a directory: %s" % req["root"])
    hits = []
    truncated = False
    gen, state = walk_tree(root, False, 64, 200000)
    for path, rel, is_dir in gen:
        if len(hits) >= cap:
            truncated = True
            break
        if is_dir or not matcher.match(rel):
            continue
        hits.append({"path": path, "rel": rel})
    return {"hits": hits, "truncated": truncated or state["truncated"]}


# ---------------------------------------------------------------------------
# watch: non-recursive mtime polling over the watched dir set
# ---------------------------------------------------------------------------

_watch_lock = threading.Lock()
_watched = {}  # dir -> refcount
_snapshots = {}  # dir -> {name: (size, mtime, kind)}


def _snapshot(dirpath):
    snap = {}
    try:
        for entry in os.scandir(dirpath):
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            snap[entry.name] = (st.st_size, st.st_mtime, statmod.S_ISDIR(st.st_mode))
    except OSError:
        return None
    return snap


def op_watch_add(req):
    with _watch_lock:
        for raw in req.get("paths", []):
            path = os.path.realpath(norm(raw))
            if not os.path.isdir(path) or os.path.basename(path) in PRUNE_DIRS:
                continue
            _watched[path] = _watched.get(path, 0) + 1
            if path not in _snapshots:
                snap = _snapshot(path)
                if snap is not None:
                    _snapshots[path] = snap
    return None


def op_watch_remove(req):
    with _watch_lock:
        for raw in req.get("paths", []):
            path = os.path.realpath(norm(raw))
            count = _watched.get(path, 0)
            if count <= 1:
                _watched.pop(path, None)
                _snapshots.pop(path, None)
            else:
                _watched[path] = count - 1
    return None


def watch_loop():
    while True:
        time.sleep(WATCH_POLL_SECS)
        changed = []
        with _watch_lock:
            dirs = list(_watched.keys())
        for d in dirs:
            new = _snapshot(d)
            with _watch_lock:
                old = _snapshots.get(d)
                if new is None:
                    if d in _snapshots:
                        del _snapshots[d]
                        changed.append(d)
                    continue
                if old is None:
                    _snapshots[d] = new
                    continue
                if old != new:
                    names = set(old) | set(new)
                    for name in names:
                        if old.get(name) != new.get(name):
                            changed.append(os.path.join(d, name))
                    _snapshots[d] = new
        if changed:
            send({"event": "fs_changed", "paths": changed})


OPS = {
    "hello": op_hello,
    "read_dir": op_read_dir,
    "list_subdirs": op_list_subdirs,
    "read_file": op_read_file,
    "read_file_b64": op_read_file_b64,
    "write_file": op_write_file,
    "write_file_b64": op_write_file_b64,
    "stat": op_stat,
    "canonicalize": op_canonicalize,
    "create_file": op_create_file,
    "create_dir": op_create_dir,
    "rename": op_rename,
    "delete": op_delete,
    "search": op_search,
    "list_files": op_list_files,
    "grep": op_grep,
    "glob": op_glob,
    "pty_cwd": op_pty_cwd,
    "watch_add": op_watch_add,
    "watch_remove": op_watch_remove,
}


def handle(req):
    rid = req.get("id")
    op = req.get("op")
    fn = OPS.get(op)
    if fn is None:
        send({"id": rid, "ok": False, "error": "unknown op: %r" % op})
        return
    try:
        data = fn(req)
        send({"id": rid, "ok": True, "data": data})
    except Exception as e:  # noqa: BLE001 - every failure must produce a reply
        send({"id": rid, "ok": False, "error": str(e)})


def main():
    threading.Thread(target=watch_loop, daemon=True).start()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        t = threading.Thread(target=handle, args=(req,), daemon=True)
        t.start()


if __name__ == "__main__":
    main()
