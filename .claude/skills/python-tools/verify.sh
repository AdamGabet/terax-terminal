#!/usr/bin/env bash
# Verify Terax's Python tooling (debugpy, ruff, pyright) is installed in a
# project's venv — checked through the venv binaries Terax actually spawns.
# Usage: verify.sh [project-root]   (defaults to cwd)
set -u

root="${1:-$PWD}"
root="${root%/}"

# Match Terax's probe order: .venv first, then venv (POSIX bin/ layout).
py=""
for cand in "$root/.venv/bin/python" "$root/venv/bin/python"; do
  if [ -x "$cand" ]; then py="$cand"; break; fi
done

if [ -z "$py" ]; then
  echo "✗ no venv found at $root/.venv or $root/venv"
  echo "  → run: (cd '$root' && uv venv && uv pip install debugpy ruff pyright)"
  exit 1
fi

bindir="$(dirname "$py")"
echo "venv: $py"

# Terax's Python LSP (pyright) resolves the project root by these markers only;
# .git alone does NOT count (matters for git worktrees). No marker => the LSP
# never starts and any per-repo venv override is ignored.
if ls "$root"/pyproject.toml "$root"/setup.py "$root"/requirements.txt "$root"/Pipfile >/dev/null 2>&1; then
  echo "root marker: found in $root"
else
  echo "⚠ root marker: NONE (pyproject.toml/setup.py/requirements.txt/Pipfile) in $root"
  echo "  Terax's pyright LSP won't start without one. Add a minimal pyproject.toml:"
  echo "    printf '[project]\\nname = \"%s\"\\nversion = \"0.0.0\"\\n' \"\$(basename '$root')\" > '$root/pyproject.toml'"
fi
echo

fail=0
check() {
  local label="$1"; shift
  if out="$("$@" 2>&1)"; then
    # Show the version line (last non-empty), skipping any stderr warnings
    # debugpy prints ahead of it.
    printf '✓ %-8s %s\n' "$label" "$(printf '%s' "$out" | grep -v '^[[:space:]]*$' | tail -n1)"
  else
    printf '✗ %-8s not working\n' "$label"
    printf '%s\n' "$out" | sed 's/^/    /' | head -n3
    fail=1
  fi
}

check debugpy "$py" -m debugpy --version
check ruff    "$bindir/ruff" --version
# pyright's first run downloads a bundled Node; this can take 10-30s.
check pyright "$bindir/pyright" --version

echo
if [ "$fail" -eq 0 ]; then
  echo "All three tools OK — Terax LSP, formatting, and debugger should work."
else
  echo "Install the missing tools: (cd '$root' && uv pip install debugpy ruff pyright)"
  exit 1
fi
