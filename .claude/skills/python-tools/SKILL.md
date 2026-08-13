---
name: python-tools
description: Set up a Python project's venv (with uv) so Terax's editor features work — the pyright LSP, ruff formatting, and the debugpy debugger. Use when the user opens/edits a Python project and the language server, format-on-save, or the debugger (F5 / Debug pill) isn't working, reports "debugpy is not installed", "pyright-langserver not found", or "ruff not found", or when the user asks to "set up python", "install the lsp/ruff/debugger", or "make the python tools work" for a repo.
---

# Python tooling for Terax (uv)

Terax's Python features each shell out to a binary and **resolve it from the
project's venv first** (`<root>/.venv/bin/`, then `<root>/venv/bin/`), falling
back to PATH. Installing these three into the project's `.venv` is what makes
them "just work":

| Feature | Binary Terax spawns | PyPI package |
|---|---|---|
| Language server (hover, go-to-def, diagnostics) | `pyright-langserver` | `pyright` |
| Format-on-save / format command | `ruff format` | `ruff` |
| Debugger (F5, Debug pill, MCP) | `python -m debugpy.adapter` | `debugpy` |

Use **`uv`** for everything (the user's standard — never pip/pip3/conda directly).

## The project root must have a marker file (most common cause of "nothing happens")

Before it spawns anything, Terax resolves the **project root** by walking up
from the open file looking for one of these markers, and the Python LSP
(pyright) only recognizes:

    pyproject.toml   setup.py   requirements.txt   Pipfile

If **none** of these exist anywhere up the tree, root resolution returns
nothing and **the LSP never starts at all** — no error toast, the pill just
stays idle. This also breaks the per-repo *venv override*, because that
override is keyed by the resolved root: no root → the override you typed at the
bottom is silently ignored.

> **`.git` is not enough.** A bare `.git` only counts as a marker for servers
> that declare *no* markers of their own; pyright declares the four above, so a
> folder with only `.git` (very common in a **git worktree**, which has just a
> `.git` file) will not resolve. Worktrees almost always need an explicit
> marker added.

**Fix:** put a minimal `pyproject.toml` at the folder you want to be the root
(the same folder whose venv you point Terax at). Even a two-line file is enough
— existence is all Terax checks:

```toml
[project]
name = "my-project"
version = "0.0.0"
```

```bash
# from the intended project root:
test -f pyproject.toml || printf '[project]\nname = "%s"\nversion = "0.0.0"\n' "$(basename "$PWD")" > pyproject.toml
```

Make sure this marker sits at (or above) the files you edit **and** matches the
root your venv override is keyed to. After adding it, reopen the file (or
toggle the LSP off/on in Settings) so Terax re-resolves the root.

## Steps

Run all commands from the **project root** (the folder with `pyproject.toml`,
`requirements.txt`, `setup.py`, or `.git` — the same root Terax resolves). Ask
the user for it, or confirm the cwd, before proceeding.

### 1. Ensure a venv exists at `.venv`

Terax probes `.venv/bin/python` then `venv/bin/python`. Prefer `.venv`.

```bash
# Skip if .venv/bin/python already exists.
uv venv                    # creates ./.venv with a default Python
# or pin a version: uv venv --python 3.12
```

### 2. Install the three tools into that venv

```bash
uv pip install debugpy ruff pyright
```

- If the project is a **uv-managed project** (has `pyproject.toml` with a
  `[tool.uv]` / `[project]` table the user manages with `uv add`), prefer:
  `uv add --dev debugpy ruff pyright` — this records them in `pyproject.toml`.
  It still installs into `.venv`, so Terax finds them either way.
- Never install these globally when the goal is a specific project — the
  venv-local copy is what Terax prefers and what keeps versions per-project.

### 3. Verify each tool works

Always verify through the **venv's own python/binaries**, because that is
exactly what Terax spawns. Do not trust a PATH-level `ruff`/`pyright`.

```bash
.venv/bin/python -m debugpy --version     # debugger adapter
.venv/bin/ruff --version                  # formatter
.venv/bin/pyright --version               # language server (see note)
```

All three should print a version with exit code 0.

> **pyright note:** the `pyright` PyPI package is a wrapper that downloads a
> bundled Node.js on its *first* run — the first `pyright --version` can take
> 10–30s and print "Downloading …". That's expected; it's cached afterward.
> If Node download is blocked, `npm install -g pyright` is the alternative
> (Terax's built-in install hint), but the venv route keeps it project-local.

You can run the bundled check instead of the three lines above:

```bash
bash .claude/skills/python-tools/verify.sh          # checks ./.venv
bash .claude/skills/python-tools/verify.sh /path/to/root
```

### 4. Point Terax at the venv (only if it still can't find them)

Terax auto-detects `<root>/.venv` and `<root>/venv`. If the venv lives
elsewhere (e.g. a shared/uv-cache venv, or a non-standard name):

- **LSP (ruff/pyright):** Settings → LSP servers → set the per-repo *venv path*
  for this project root (see `src/settings/components/LspServersGroup.tsx`).
- **Debugger:** open the Debug dock and pick the interpreter from the dropdown
  (persisted per root+workspace via `getPythonOverride`), or ensure the venv is
  at `.venv`. The dock warns when the selected interpreter lacks debugpy.

After changing a venv path, Terax re-probes on the next file open / debug run
(negative detections aren't cached).

## Troubleshooting

- **LSP pill never starts / no error at all, and the venv override seems
  ignored** → no root marker. Terax couldn't resolve a project root, so it
  never spawned the server and never looked up your venv override. Add a
  `pyproject.toml` (see the root-marker section above), especially in git
  worktrees (which have only a `.git` file). Confirm the marker sits at the
  exact folder your venv override is keyed to.
- **"No module named debugpy"** in the debug console → debugpy isn't in the
  interpreter Terax chose. Re-run step 2 against the *right* venv, or pick the
  correct interpreter in the Debug dock. The exact fix Terax suggests:
  `uv pip install -p <that-python> debugpy`.
- **LSP pill stays "starting"/errored** → `pyright-langserver` didn't resolve.
  Confirm `.venv/bin/pyright-langserver` exists (`ls .venv/bin/pyright*`); the
  `pyright` package installs both `pyright` and `pyright-langserver`.
- **Format-on-save does nothing for `.py`** → `ruff` not resolved, or the
  formatter for Python isn't set to Ruff in Settings. Confirm
  `.venv/bin/ruff` exists.
- **SSH workspace** → install the three into the venv **on the remote host**;
  Terax resolves and spawns them there. Windows venv layout uses
  `.venv/Scripts/` instead of `.venv/bin/` (local only; SSH remotes are POSIX).
