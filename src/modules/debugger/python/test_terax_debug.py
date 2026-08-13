"""Unit tests for the Terax debug tracer/snapshot helper.

Run:  uv run --with pytest [--with torch] pytest src/modules/debugger/python/
torch-dependent tests skip automatically when torch is missing.
"""

import importlib.util
import io
import json
import os
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "terax_debug", os.path.join(_HERE, "terax_debug.py")
)
td = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(td)

torch = None
try:  # optional
    import torch  # noqa: F401
except ImportError:
    pass


# --- describe: plain python ---


def test_scalars():
    assert td.describe(3) == {"kind": "scalar", "type": "int", "value": 3}
    assert td.describe(True)["type"] == "bool"
    assert td.describe(2.5)["value"] == 2.5


def test_nonfinite_floats_stringified():
    assert td.describe(float("nan"))["value"] == "nan"
    assert td.describe(float("inf"))["value"] == "inf"
    json.dumps(td.describe(float("nan")))  # must stay JSON-safe


def test_str_truncation():
    d = td.describe("x" * 500)
    assert d["len"] == 500
    assert len(d["value"]) <= 121


def test_none_and_objects():
    assert td.describe(None) == {"kind": "none"}
    assert td.describe(object())["kind"] == "obj"


def test_seq_depth_and_caps():
    d = td.describe([[1] * 50] * 40)
    assert d["len"] == 40
    assert len(d["items"]) <= 8
    assert d["items"][0]["len"] == 50
    assert len(d["items"][0]["items"]) <= 3  # nested cap


def test_dict_items():
    d = td.describe({"a": 1, "b": [2, 3]})
    assert d["kind"] == "map"
    assert d["items"]["a"]["value"] == 1


def test_describe_never_raises():
    class Nasty:
        @property
        def shape(self):
            raise RuntimeError("boom")

        def __repr__(self):
            raise RuntimeError("boom")

    out = td.describe(Nasty())
    assert out["kind"] in ("obj", "opaque")


# --- snap ---


def test_snap_returns_prefixed_json():
    line = td.snap("p1", "shape", x=[1, 2, 3])
    assert line.startswith(td.PREFIX)
    payload = json.loads(line[len(td.PREFIX) :])
    assert payload["probe"] == "p1"
    assert payload["values"]["x"]["len"] == 3


def test_snap_all_expands_locals():
    line = td.snap("p2", "shape", _all={"a": 1, "__hidden": 2})
    payload = json.loads(line[len(td.PREFIX) :])
    assert "a" in payload["values"]
    assert "__hidden" not in payload["values"]


# --- tracer ---

# Both hook backends must behave identically; "auto" resolves to
# sys.monitoring on 3.12+ and to setprofile below.
BACKENDS = ["profile"] + (["auto"] if sys.version_info >= (3, 12) else [])


def _run_traced(fn, backend="auto", root=_HERE):
    events = []
    real_write = sys.stderr.write

    def capture(s):
        if s.startswith(td.PREFIX):
            events.append(json.loads(s[len(td.PREFIX) :]))
            return len(s)
        return real_write(s)

    tracer = td._Tracer(root)
    old_backend = td._CONFIG["backend"]
    td._CONFIG["backend"] = backend
    sys.stderr.write = capture
    try:
        tracer.install()
        fn()
    finally:
        tracer.uninstall()
        tracer.flush()
        sys.stderr.write = real_write
        td._CONFIG["backend"] = old_backend
    return tracer, events


@pytest.mark.parametrize("backend", BACKENDS)
def test_tracer_builds_call_graph(backend):
    def leaf(x):
        return x * 2

    def mid(x):
        return leaf(x) + 1

    def top():
        return [mid(i) for i in range(3)]

    tracer, events = _run_traced(top, backend)
    names = {n["name"].split(".")[-1] for n in tracer.nodes.values()}
    assert {"leaf", "mid"} <= names
    leaf_node = next(n for n in tracer.nodes.values() if "leaf" in n["name"])
    assert leaf_node["count"] == 3
    assert leaf_node["ret"]["kind"] == "scalar"
    assert leaf_node["args"]["x"]["kind"] == "scalar"
    assert any(e["type"] == "graph" for e in events)
    edge_pairs = {(a.split(":")[-1], b.split(":")[-1]) for a, b in tracer.edges}
    assert any("mid" in a and "leaf" in b for a, b in edge_pairs)


@pytest.mark.parametrize("backend", BACKENDS)
def test_tracer_ring_capped(backend):
    def leaf():
        return 1

    def top():
        for _ in range(100):
            leaf()

    tracer, _ = _run_traced(top, backend)
    leaf_node = next(n for n in tracer.nodes.values() if "leaf" in n["name"])
    assert leaf_node["count"] == 100
    assert len(leaf_node["recent"]) <= td._CONFIG["ring"]


@pytest.mark.parametrize("backend", BACKENDS)
def test_tracer_skips_site_packages(backend, tmp_path):
    fake = tmp_path / "site-packages" / "lib.py"
    fake.parent.mkdir(parents=True)
    fake.write_text("def libfn():\n    return 1\n")
    scope = {}
    exec(compile(fake.read_text(), str(fake), "exec"), scope)

    tracer, _ = _run_traced(scope["libfn"], backend)
    assert not any("libfn" in n["name"] for n in tracer.nodes.values())


@pytest.mark.parametrize("backend", BACKENDS)
def test_tracer_records_exception_exits(backend):
    def boom():
        raise ValueError("x")

    def top():
        try:
            boom()
        except ValueError:
            pass
        return 1

    tracer, _ = _run_traced(top, backend)
    boom_node = next(n for n in tracer.nodes.values() if "boom" in n["name"])
    assert boom_node["count"] == 1
    assert boom_node["ret"] is None


@pytest.mark.parametrize("backend", BACKENDS)
def test_tracer_recursion_stays_paired(backend):
    def rec(n):
        return 1 if n == 0 else rec(n - 1) + 1

    tracer, _ = _run_traced(lambda: rec(5), backend)
    rec_node = next(n for n in tracer.nodes.values() if "rec" in n["name"])
    assert rec_node["count"] == 6


@pytest.mark.skipif(
    sys.version_info < (3, 12), reason="sys.monitoring needs Python 3.12+"
)
def test_monitoring_backend_selected_on_312():
    tracer, _ = _run_traced(lambda: None, backend="auto")
    assert tracer.backend == "monitoring"


def test_profile_backend_forced():
    tracer, _ = _run_traced(lambda: None, backend="profile")
    assert tracer.backend == "profile"


def test_compiled_hint_badges_nodes(tmp_path):
    compiled = tmp_path / "compiled_mod.py"
    marker = "torch." + "compile"  # keep THIS file's source marker-free
    compiled.write_text(f"# model = {marker}(model)\ndef fn():\n    return 1\n")
    plain = tmp_path / "plain_mod.py"
    plain.write_text("def gn():\n    return 2\n")
    scope = {}
    exec(compile(compiled.read_text(), str(compiled), "exec"), scope)
    exec(compile(plain.read_text(), str(plain), "exec"), scope)

    def both():
        scope["fn"]()
        scope["gn"]()

    tracer, _ = _run_traced(both, root=str(tmp_path))
    fn_node = next(n for n in tracer.nodes.values() if ":fn" in n["key"])
    gn_node = next(n for n in tracer.nodes.values() if ":gn" in n["key"])
    assert fn_node.get("compiled_hint") is True
    assert "compiled_hint" not in gn_node


# --- torch ---


@pytest.mark.skipif(torch is None, reason="torch not installed")
class TestTorch:
    def test_tensor_shape_capture(self):
        t = torch.zeros(4, 16)
        d = td.describe(t)
        assert d["kind"] == "tensor"
        assert d["shape"] == [4, 16]
        assert d["dtype"] == "float32"
        assert "version" in d and "ptr" in d

    def test_stats_capture_counts_nonfinite(self):
        t = torch.tensor([1.0, float("nan"), 3.0, float("inf")])
        d = td.describe(t, capture="stats")
        assert d["nonfinite"] == 2
        assert d["min"] == 1.0
        assert d["max"] == 3.0

    def test_inplace_bumps_version_same_id(self):
        t = torch.zeros(3)
        before = td.describe(t)
        t.add_(1.0)
        after = td.describe(t)
        assert before["id"] == after["id"]
        assert after["version"] > before["version"]

    def test_rebind_changes_id(self):
        t = torch.zeros(3)
        before = td.describe(t)
        t = t + 1
        after = td.describe(t)
        assert before["id"] != after["id"]

    def test_view_shares_storage_ptr(self):
        t = torch.zeros(4, 4)
        v = t.view(16)
        assert td.describe(t)["ptr"] == td.describe(v)["ptr"]

    def test_single_element_stats_stay_json_safe(self):
        # std() of one element is NaN; a bare NaN token breaks JS JSON.parse.
        d = td.describe(torch.tensor([2.0]), capture="stats")
        text = json.dumps(d)
        json.loads(text)
        assert "NaN" not in text
        assert d["std"] == "nan"

    def test_zero_dim_empty_bool_bfloat16(self):
        assert td.describe(torch.tensor(1.5), "stats")["shape"] == []
        assert td.describe(torch.empty(0), "stats")["shape"] == [0]
        assert td.describe(torch.zeros(2, dtype=torch.bool), "stats")["dtype"] == "bool"
        d = td.describe(torch.zeros(8, dtype=torch.bfloat16), "stats")
        assert d["dtype"] == "bfloat16"
        assert d["mean"] == 0.0

    def test_grad_state(self):
        p = torch.zeros(3, requires_grad=True)
        d = td.describe(p)
        assert d["requires_grad"] is True
        assert d["has_grad"] is False

    def test_stats_do_not_build_graph(self):
        p = torch.ones(3, requires_grad=True)
        loss = (p * 2).sum()
        td.describe(loss, capture="stats")
        assert torch.is_grad_enabled()
        loss.backward()  # graph intact, not consumed by the probe
        assert p.grad is not None

    def test_module_summary(self):
        class Net(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.fc = torch.nn.Linear(4, 2)

        d = td.describe(Net())
        assert d["kind"] == "module"
        assert d["type"] == "Net"
        assert d["params"] == 4 * 2 + 2
