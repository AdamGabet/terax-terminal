"""Terax debug bootstrap + execution tracer.

Launched by Terax as the debugpy `program`, with the real script as argv[1]:

    python -m debugpy ... terax_debug.py <script.py> [script args...]

It installs a call/return profiler scoped to the project root, runs the user
script via runpy, and streams compact JSONL events (execution-map deltas,
variable snapshots, crash reports) to stderr with a magic prefix. Terax's DAP
client demuxes those lines out of the debug adapter's output events.

Configuration comes from the TERAX_DEBUG_CONFIG env var (JSON):
    {"root": "/abs/project", "trace": true, "capture": "shape",
     "flush_ms": 250, "max_hits": 200000, "ring": 20, "backend": "auto"}

`backend` picks the tracer hook: "auto" uses sys.monitoring on Python 3.12+
(falling back to sys.setprofile), "profile" forces the setprofile path.

No third-party imports. torch/numpy are described only if the *user's*
program imported them (looked up via sys.modules, never imported here).
"""

import json
import os
import runpy
import sys
import threading
import time
import traceback
import warnings

PREFIX = "@@TERAX_DBG@@"

_CONFIG = {
    "root": "",
    "trace": True,
    "capture": "shape",
    "flush_ms": 250,
    "max_hits": 200_000,
    "ring": 20,
    "backend": "auto",
}
try:
    _CONFIG.update(json.loads(os.environ.get("TERAX_DEBUG_CONFIG", "") or "{}"))
except ValueError:
    pass

_MAX_DEPTH = 2
_MAX_ITEMS = 8
_MAX_STR = 120
_MAX_LOCALS = 50

_seq = 0
_seq_lock = threading.Lock()


def _next_seq():
    global _seq
    with _seq_lock:
        _seq += 1
        return _seq


def _emit(event):
    """One JSONL event onto (possibly debugpy-redirected) stderr."""
    event["seq"] = _next_seq()
    event["t"] = round(time.perf_counter() - _T0, 6)
    try:
        line = json.dumps(event, default=str)
    except (TypeError, ValueError):
        return
    try:
        sys.stderr.write(PREFIX + line + "\n")
        sys.stderr.flush()
    except (OSError, ValueError, AttributeError):
        pass


# ---------------------------------------------------------------------------
# Value description


def _mod(value):
    m = type(value).__module__ or ""
    return m.split(".", 1)[0]


def _num(x):
    """JSON-safe number: json.dumps would emit a bare NaN/Infinity token,
    which strict parsers (JS JSON.parse) reject."""
    f = float(x)
    if f != f or f in (float("inf"), float("-inf")):
        return str(f)
    return round(f, 6)


def _tensor_info(value, capture):
    torch = sys.modules.get("torch")
    info = {
        "kind": "tensor",
        "shape": list(value.shape),
        "dtype": str(value.dtype).replace("torch.", ""),
        "device": str(value.device),
        "id": id(value),
    }
    try:
        info["ptr"] = value.data_ptr()
    except (RuntimeError, AttributeError):
        pass
    try:
        info["version"] = value._version
    except AttributeError:
        pass
    try:
        info["requires_grad"] = bool(value.requires_grad)
        if value.is_leaf and value.requires_grad:
            info["has_grad"] = value.grad is not None
    except (RuntimeError, AttributeError):
        pass
    if capture == "stats" and torch is not None and value.numel() > 0:
        try:
            with torch.no_grad(), warnings.catch_warnings():
                warnings.simplefilter("ignore")  # e.g. std() of 1 element
                t = value.detach()
                if t.dtype in (torch.complex64, torch.complex128):
                    t = t.abs()
                if not t.dtype.is_floating_point:
                    info["min"] = _num(t.min().item())
                    info["max"] = _num(t.max().item())
                else:
                    f = t.float() if t.dtype != torch.float32 else t
                    finite = torch.isfinite(f)
                    n_bad = int((~finite).sum().item())
                    info["nonfinite"] = n_bad
                    if n_bad < f.numel():
                        sel = f[finite] if n_bad else f
                        agg = torch.stack(
                            [sel.min(), sel.max(), sel.mean(), sel.std()]
                        ).tolist()
                        info["min"], info["max"], info["mean"], info["std"] = [
                            _num(x) for x in agg
                        ]
        except (RuntimeError, ValueError):
            pass
    return info


def _ndarray_info(value, capture):
    np = sys.modules.get("numpy")
    info = {
        "kind": "ndarray",
        "shape": list(value.shape),
        "dtype": str(value.dtype),
        "id": id(value),
    }
    if capture == "stats" and np is not None and value.size > 0:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                if value.dtype.kind == "f":
                    finite = np.isfinite(value)
                    n_bad = int(value.size - finite.sum())
                    info["nonfinite"] = n_bad
                    sel = value[finite] if n_bad else value
                    if sel.size:
                        info["min"] = _num(sel.min())
                        info["max"] = _num(sel.max())
                        info["mean"] = _num(sel.mean())
                        info["std"] = _num(sel.std())
                elif value.dtype.kind in "iub":
                    info["min"] = int(value.min())
                    info["max"] = int(value.max())
        except (ValueError, TypeError):
            pass
    return info


def describe(value, capture="shape", depth=0):
    """A compact, JSON-safe summary of any Python value. Never raises,
    never keeps a reference, never builds autograd graph."""
    try:
        return _describe(value, capture, depth)
    except Exception:  # noqa: BLE001 - a probe must never kill the program
        return {"kind": "opaque", "type": type(value).__name__}


def _describe(value, capture, depth):
    if value is None:
        return {"kind": "none"}
    if isinstance(value, bool):
        return {"kind": "scalar", "type": "bool", "value": value}
    if isinstance(value, (int, float)):
        v = value
        if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
            return {"kind": "scalar", "type": "float", "value": str(v)}
        return {"kind": "scalar", "type": type(value).__name__, "value": v}
    if isinstance(value, str):
        s = value if len(value) <= _MAX_STR else value[:_MAX_STR] + "…"
        return {"kind": "scalar", "type": "str", "len": len(value), "value": s}
    root_mod = _mod(value)
    if root_mod == "torch" and type(value).__name__ in ("Tensor", "Parameter"):
        return _tensor_info(value, capture)
    if root_mod == "numpy" and hasattr(value, "shape") and hasattr(value, "dtype"):
        return _ndarray_info(value, capture)
    if isinstance(value, (list, tuple, set, frozenset)):
        out = {"kind": "seq", "type": type(value).__name__, "len": len(value)}
        if depth < _MAX_DEPTH:
            cap = _MAX_ITEMS if depth == 0 else 3
            out["items"] = [
                _describe(v, capture, depth + 1) for v in list(value)[:cap]
            ]
        return out
    if isinstance(value, dict):
        out = {"kind": "map", "len": len(value)}
        if depth < _MAX_DEPTH:
            out["items"] = {
                str(k)[:40]: _describe(v, capture, depth + 1)
                for k, v in list(value.items())[:_MAX_ITEMS]
            }
        return out
    # nn.Module (user subclasses live in their own module, so no root_mod
    # gate): name + parameter count beats a giant repr.
    torch = sys.modules.get("torch")
    if torch is not None:
        try:
            if isinstance(value, torch.nn.Module):
                return {
                    "kind": "module",
                    "type": type(value).__name__,
                    "params": sum(p.numel() for p in value.parameters()),
                    "training": value.training,
                }
        except Exception:  # noqa: BLE001
            pass
    return {"kind": "obj", "type": type(value).__name__}


# ---------------------------------------------------------------------------
# Snapshot probe (called from logpoint expressions via builtins)


def snap(probe_id, capture=None, **named):
    """`{__terax_snap('p3', x=x, loss=loss)}` inside a Terax tracepoint.
    Returns the payload line so the logpoint's own output carries it.
    `_all=locals()` expands to every local (dunders skipped)."""
    capture = capture or _CONFIG["capture"]
    everything = named.pop("_all", None)
    if isinstance(everything, dict):
        for k, v in everything.items():
            if not k.startswith("__") and k not in named:
                named[k] = v
    values = {k: describe(v, capture) for k, v in named.items()}
    payload = {"type": "snap", "probe": probe_id, "values": values}
    payload["seq"] = _next_seq()
    payload["t"] = round(time.perf_counter() - _T0, 6)
    try:
        return PREFIX + json.dumps(payload, default=str)
    except (TypeError, ValueError):
        return PREFIX + json.dumps({"type": "snap", "probe": probe_id, "error": "unserializable"})


# ---------------------------------------------------------------------------
# Execution-map tracer


_MON = getattr(sys, "monitoring", None)
_MON_DISABLE = getattr(_MON, "DISABLE", None)
_MON_EVENTS = ("PY_START", "PY_RETURN", "PY_UNWIND")


class _Tracer:
    def __init__(self, root):
        self.root = os.path.realpath(root) + os.sep if root else None
        self.own_file = os.path.realpath(__file__)
        self.code_ok = {}  # id(code) -> bool, decided once per code object
        self.compile_files = {}  # co_filename -> bool, torch.compile hint
        self.nodes = {}  # key -> aggregate
        self.edges = {}  # (parent, child) -> count
        self.dirty_nodes = set()
        self.dirty_edges = set()
        self.local = threading.local()
        self.lock = threading.Lock()
        self.hits = 0
        self.exhausted = False
        self.last_flush = time.perf_counter()
        self.flush_every = max(_CONFIG["flush_ms"], 50) / 1000.0
        self.backend = None  # "monitoring" | "profile", set by install()
        self._mon_active = False

    def _traced(self, code):
        entry = self.code_ok.get(id(code))
        if entry is not None:
            return entry[0]
        fn = code.co_filename
        if fn.startswith("<") or code.co_name.startswith("<"):
            ok = False  # <string>/<module>/genexpr/lambda noise
        else:
            real = os.path.realpath(fn)  # resolves relative against cwd
            ok = (
                self.root is not None
                and real.startswith(self.root)
                and real != self.own_file
                # In-project venvs (.venv/) would otherwise pass the
                # root check and leak debugger internals into the map.
                and "site-packages" not in real
                and "dist-packages" not in real
            )
        # Store the code object itself: id()s of dead code objects get
        # recycled (runpy compiles the user script AFTER bootstrap frames
        # were cached), and a stale hit silently untraced user functions.
        self.code_ok[id(code)] = (ok, code)
        return ok

    def _stack(self):
        s = getattr(self.local, "stack", None)
        if s is None:
            s = []
            self.local.stack = s
        return s

    def _node_key(self, code):
        qual = getattr(code, "co_qualname", code.co_name)
        return f"{code.co_filename}:{qual}"

    def _capture_args(self, code, frame):
        args = {}
        try:
            names = code.co_varnames[: code.co_argcount]
            loc = frame.f_locals
            for n in names[:_MAX_ITEMS]:
                if n in loc and n != "self":
                    args[n] = describe(loc[n], "shape", depth=1)
        except Exception:  # noqa: BLE001
            pass
        return args

    def _compiled_hint(self, fn):
        """torch.compile'd regions run without Python-level call events, so
        their inner calls are invisible to the tracer. Badge nodes from files
        that mention torch.compile so the map's gaps are explainable."""
        hint = self.compile_files.get(fn)
        if hint is None:
            hint = False
            if not fn.startswith("<"):
                try:
                    with open(fn, encoding="utf-8", errors="ignore") as f:
                        src = f.read(1_000_000)
                    hint = "torch.compile" in src or "torch._dynamo" in src
                except OSError:
                    pass
            self.compile_files[fn] = hint
        return hint

    # --- sys.setprofile backend (< 3.12) ---

    def profile(self, frame, event, arg):
        if event == "call":
            code = frame.f_code
            if not self._traced(code):
                # Still push a marker so returns stay balanced? No: profile
                # events fire for every frame; track only traced ones by
                # keying the stack entry to the frame object.
                return
            args = self._capture_args(code, frame)
            self._stack().append((frame, self._node_key(code), time.perf_counter(), args))
        elif event == "return":
            stack = self._stack()
            if not stack or stack[-1][0] is not frame:
                return
            _, key, t0, args = stack.pop()
            parent = stack[-1][1] if stack else None
            ret = describe(arg, "shape", depth=1) if arg is not None else None
            self._record(frame.f_code, key, parent, time.perf_counter() - t0, args, ret)

    # --- sys.monitoring backend (3.12+) ---
    # Callbacks receive code objects, not frames: the per-thread stack keys
    # entries on the code object (LIFO keeps recursion paired), and args come
    # from sys._getframe(1) — the monitored frame — at PY_START. Returning
    # DISABLE for untraced code turns those locations off entirely, which is
    # where the overhead win over setprofile comes from.

    def _on_py_start(self, code, _offset):
        if not self._traced(code):
            return _MON_DISABLE
        try:
            frame = sys._getframe(1)
        except ValueError:
            return None
        args = self._capture_args(code, frame)
        self._stack().append((code, self._node_key(code), time.perf_counter(), args))
        return None

    def _on_py_return(self, code, _offset, retval):
        if not self._traced(code):
            return _MON_DISABLE
        stack = self._stack()
        if not stack or stack[-1][0] is not code:
            return None
        _, key, t0, args = stack.pop()
        parent = stack[-1][1] if stack else None
        ret = describe(retval, "shape", depth=1) if retval is not None else None
        self._record(code, key, parent, time.perf_counter() - t0, args, ret)
        return None

    def _on_py_unwind(self, code, _offset, _exc):
        # PY_UNWIND cannot be DISABLEd (exceptional event) — just keep the
        # stack balanced when a traced frame exits via exception.
        if not self._traced(code):
            return None
        stack = self._stack()
        if stack and stack[-1][0] is code:
            _, key, t0, args = stack.pop()
            parent = stack[-1][1] if stack else None
            self._record(code, key, parent, time.perf_counter() - t0, args, None)
        return None

    def _record(self, code, key, parent, dt, args, ret):
        with self.lock:
            self.hits += 1
            node = self.nodes.get(key)
            if node is None:
                node = {
                    "key": key,
                    "file": code.co_filename,
                    "line": code.co_firstlineno,
                    "name": getattr(code, "co_qualname", code.co_name),
                    "count": 0,
                    "time": 0.0,
                    "recent": [],
                }
                if self._compiled_hint(code.co_filename):
                    node["compiled_hint"] = True
                self.nodes[key] = node
            node["count"] += 1
            node["time"] += dt
            node["args"] = args
            node["ret"] = ret
            ring = node["recent"]
            ring.append(
                {
                    "n": node["count"],
                    "t": round(time.perf_counter() - _T0, 6),
                    "dt": round(dt, 6),
                    "args": args,
                    "ret": ret,
                }
            )
            if len(ring) > _CONFIG["ring"]:
                del ring[0]
            self.dirty_nodes.add(key)
            if parent:
                ek = (parent, key)
                self.edges[ek] = self.edges.get(ek, 0) + 1
                self.dirty_edges.add(ek)
            exhausted = self.hits >= _CONFIG["max_hits"] and not self.exhausted
            flush_due = time.perf_counter() - self.last_flush >= self.flush_every
        if exhausted:
            self.exhausted = True
            self.uninstall()
            self.flush()
            _emit({"type": "trace_budget_exhausted", "hits": self.hits})
        elif flush_due:
            self.flush()

    def flush(self):
        with self.lock:
            if not self.dirty_nodes and not self.dirty_edges:
                self.last_flush = time.perf_counter()
                return
            nodes = []
            for key in self.dirty_nodes:
                node = dict(self.nodes[key])
                node["time"] = round(node["time"], 6)
                nodes.append(node)
            edges = [
                {"from": a, "to": b, "count": self.edges[(a, b)]}
                for (a, b) in self.dirty_edges
            ]
            self.dirty_nodes.clear()
            self.dirty_edges.clear()
            self.last_flush = time.perf_counter()
        _emit({"type": "graph", "nodes": nodes, "edges": edges})

    def _install_monitoring(self):
        mon = _MON
        if mon is None or _CONFIG.get("backend") == "profile":
            return False
        try:
            mon.use_tool_id(mon.PROFILER_ID, "terax")
        except ValueError:
            return False  # another profiler owns the id — fall back
        # Earlier runs in this interpreter may have DISABLEd locations.
        mon.restart_events()
        for name in _MON_EVENTS:
            mon.register_callback(
                mon.PROFILER_ID,
                getattr(mon.events, name),
                getattr(self, f"_on_{name.lower()}"),
            )
        mon.set_events(
            mon.PROFILER_ID,
            mon.events.PY_START | mon.events.PY_RETURN | mon.events.PY_UNWIND,
        )
        self._mon_active = True
        return True

    def install(self):
        if self._install_monitoring():
            self.backend = "monitoring"
        else:
            self.backend = "profile"
            threading.setprofile(self.profile)
            sys.setprofile(self.profile)

    def uninstall(self):
        mon = _MON
        if self._mon_active and mon is not None:
            self._mon_active = False
            try:
                mon.set_events(mon.PROFILER_ID, 0)
                for name in _MON_EVENTS:
                    mon.register_callback(
                        mon.PROFILER_ID, getattr(mon.events, name), None
                    )
                mon.free_tool_id(mon.PROFILER_ID)
            except ValueError:
                pass
        else:
            sys.setprofile(None)
            threading.setprofile(None)


# ---------------------------------------------------------------------------
# Crash report


def _crash_report(exc_type, exc, tb):
    frames = []
    root = os.path.realpath(_CONFIG["root"]) + os.sep if _CONFIG["root"] else None
    own_file = os.path.realpath(__file__)
    for fr, lineno in traceback.walk_tb(tb):
        fn = fr.f_code.co_filename
        real = None if fn.startswith("<") else os.path.realpath(fn)
        mine = real is not None and root is not None and real.startswith(root)
        if real == own_file or (not frames and not mine):
            continue  # bootstrap + runpy prelude above the user's entry frame
        entry = {
            "file": fn,
            "line": lineno,
            "func": getattr(fr.f_code, "co_qualname", fr.f_code.co_name),
            "own": mine,
        }
        if mine:
            entry["locals"] = {
                k: describe(v, "shape", depth=1)
                for k, v in list(fr.f_locals.items())[:_MAX_LOCALS]
                if not k.startswith("__")
                and type(v).__name__ not in ("module", "function", "type")
            }
        frames.append(entry)
    _emit(
        {
            "type": "crash",
            "exc_type": exc_type.__name__,
            "exc_msg": str(exc)[:500],
            "frames": frames,
        }
    )


# ---------------------------------------------------------------------------
# Bootstrap


_T0 = time.perf_counter()


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("terax_debug.py: missing target script\n")
        sys.exit(2)
    script = sys.argv[1]
    sys.argv = sys.argv[1:]
    script_dir = os.path.dirname(os.path.realpath(script))
    root = _CONFIG.get("root") or script_dir
    module = _CONFIG.get("module")
    if root and root not in sys.path:
        sys.path.insert(0, root)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    import builtins

    builtins.__terax_snap = snap
    builtins.__terax_describe = describe

    tracer = None
    if _CONFIG.get("trace", True):
        tracer = _Tracer(root)
        builtins.__terax_tracer = tracer

    if tracer:
        tracer.install()

    _emit(
        {
            "type": "run_start",
            "script": os.path.realpath(script),
            **({"module": module} if module else {}),
            "python": sys.version.split()[0],
            "pid": os.getpid(),
            "trace": tracer is not None,
            **({"backend": tracer.backend} if tracer else {}),
        }
    )

    code = 0
    try:
        if module:
            runpy.run_module(module, run_name="__main__", alter_sys=True)
        else:
            runpy.run_path(script, run_name="__main__")
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException:  # noqa: BLE001 - report, then re-raise for debugpy
        if tracer:
            tracer.uninstall()
            tracer.flush()
        _crash_report(*sys.exc_info())
        raise
    finally:
        if tracer:
            tracer.uninstall()
            tracer.flush()
        _emit({"type": "run_end", "exit_code": code})
    sys.exit(code)


if __name__ == "__main__":
    main()
