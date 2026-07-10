# Backport Handoff

## Current status update

The implementation described below is now complete through upstream commit
`85a5653`. The previously paused cherry-pick was resolved and committed as
`4179319`. TypeScript, the production frontend build, focused editor/LSP tests,
filesystem Rust tests, Git operation tests, Rust `cargo check`, lint, and diff
checks pass.

The focused editor/LSP run had 51 passing tests and two failures only in live
Codex endpoint tests. Those tests require valid local Codex authentication and
failed at the HTTP success assertion, consistent with the previously observed
expired-token behavior. All non-live autocomplete tests passed, and Codex
remains wired as an autocomplete provider.

The duplicate editor controls were removed from `GeneralSection`; the complete
controls now live in the dedicated Editor settings tab.

Current intentional uncommitted files at the time of this update are
`HANDOFF.md` and `src/settings/sections/GeneralSection.tsx`, in addition to the
unrelated `.wolf/*` files that must not be staged. Sections below describing a
paused `85a5653` cherry-pick are retained as historical troubleshooting detail
and are no longer the current repository state.

## Goal

Continue selectively backporting the upstream v0.8.5 editor, LSP, formatter, and autocomplete features into this fork while preserving fork-specific behavior, especially Codex autocomplete, custom AI providers, SSH workspaces, file-preview tabs, and the current non-spaces architecture.

Do not modify or commit the unrelated `.wolf/*` files.

## Repository state

- Branch: `adding-new-version-0.85-features`
- Repository uses Git, not Jujutsu.
- A cherry-pick of upstream commit `85a5653` is currently paused with conflicts.
- Unrelated modified files that must remain untouched:
  - `.wolf/cerebrum.md`
  - `.wolf/hooks/_session.json`
  - `.wolf/memory.md`

## Completed work

Earlier small backports:

- `689a357` markdown HTML-wrapped code preservation
- `bd1c201` explorer rapid-root race fix
- `0af2866` AI search secret-path filtering
- `c3e454e` AI mini-window shortcut
- `2dba24d` comment punctuation cleanup
- `8b3efeb` search test adaptation

Larger feature backports:

- `a986db1` source-control branch checkout UI
- `ad48121` per-tab editor language override
- Branch creation from the branch dropdown, including Rust operation, Tauri command, native API, inline input, and focused test
- `4d1c14e` LSP frontend client and session foundation
- `9d19c49` resource-bounded LSP sessions, formatting, and cross-file navigation
- `b10e866` LSP/editor chrome, diagnostics, and status UI
- `50b5b9c` dedicated editor settings tab and LSP server settings
- `51718f5` completion kind icons and themed editor chrome, adapted to avoid restoring deleted fork theme files
- `237dd4e` frozen shared extensions, formatter preference types, and autosave clamp exports
- `ef492dd` selectable LSP, Biome, and Prettier formatting
- `c7fd546` EOL preservation, save-conflict detection, and app-close protection
- `9c4c774` mtime and forced-read filesystem support adapted for asynchronous SSH workspaces
- `0e728a3` find/replace panel, goto line, indentation detection, large-file opening, and formatter registry
- `f6cda44` diff-pane language resolution before CodeMirror mount
- `c2fa9c0` improved autocomplete placement, quality, and trigger controls, preserving Codex settings and tests
- `bfed84d` Markdown GFM extras, fenced-code highlighting, and clickable tasks

## Important adaptations already made

- Codex remains an autocomplete provider.
- Existing autocomplete reasoning settings were retained.
- Fork custom providers and custom endpoints were not replaced with upstream settings wholesale.
- Existing `file-preview` tabs were preserved. Upstream media rendering inside `EditorPane` was omitted because this fork routes images and PDFs through dedicated preview tabs.
- Existing SSH reconnect behavior in `useDocument` was preserved.
- Filesystem mtime and forced reads were adapted to the fork's `spawn_blocking` and SSH architecture.
- SSH read responses now include mtime:
  - `src-tauri/src/modules/ssh/agent.py`
  - `src-tauri/src/modules/ssh/fsops.rs`
- Cross-file LSP navigation uses `EditorPaneHandle.goToLine` and the fork's existing tab APIs.
- Upstream files intentionally deleted by this fork, such as `cmThemes.ts` and the old `useEditorFileSync.ts`, were not restored.
- Unsupported Hugeicons names in upstream editor chrome were replaced with available icons.

## Current paused cherry-pick

Upstream commit:

```text
85a5653 fix(editor): close save/reload races, formatter mtime, lsp format style and preset rebinding
```

Conflict files were reduced to:

- `src/modules/editor/EditorPane.tsx`
- `src/modules/lsp/lib/client.ts`

Both conflict markers have been removed and the files are staged, but TypeScript currently fails. Other files from this cherry-pick auto-merged, including:

- `src/app/hooks/useAppCloseGuard.ts`
- `src/modules/editor/lib/externalFormat.ts`
- `src/modules/editor/lib/useDocument.ts`
- `src/modules/lsp/lib/useLspExtension.ts`

Do not abort unless the current adaptations are intentionally being discarded.

## Current TypeScript errors

The last command was:

```bash
rtk git add -- src/modules/editor/EditorPane.tsx src/modules/lsp/lib/client.ts && \
rtk git diff --check && \
rtk tsc --noEmit && \
rtk vitest src/modules/editor/lib/eol.test.ts \
  src/modules/editor/lib/externalFormat.test.ts \
  src/modules/editor/lib/indent.test.ts \
  src/modules/editor/lib/autocomplete/normalizeIndent.test.ts \
  src/modules/editor/lib/autocomplete/trimSuggestion.test.ts \
  src/modules/lsp/lib/uri.test.ts
```

TypeScript errors:

```text
src/modules/editor/EditorPane.tsx(174,13): error TS2322:
Type 'void' is not assignable to type '"done" | "unsupported"'.

src/modules/lsp/lib/client.ts: unused imports:
- highlightingFor
- language
- StateEffect
- StateField
- Decoration
- DecorationSet
- ViewPlugin
- highlightCode
```

## Exact next fix

`src/modules/lsp/lib/client.ts` in this fork does not contain all of the newer upstream semantic-highlighting implementation. Keep only imports actually used by the current file:

```ts
import { indentUnit } from "@codemirror/language";
import type { Extension, Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
```

The important change from `85a5653` is this formatting option:

```ts
insertSpaces: view.state.facet(indentUnit) !== "\t"
```

The current `formatDocumentAndWait` returns `Promise<boolean>`, while the incoming `EditorPane` code expects `"done" | "unsupported"`. Choose one consistent API. The smallest safe adaptation is:

1. Keep `formatDocumentAndWait` returning `Promise<boolean>`.
2. Keep `lspFormatDocument` returning `Promise<void>`.
3. In `EditorPane.performSave`, call:

```ts
try {
  await lspFormatDocument(view);
} catch (error) {
  toast.error("Language server format failed", {
    description: String(error),
  });
}
```

4. Remove the `"unsupported"` result handling and `warnedNoFormatRef` unless the return type is deliberately upgraded through both `client.ts` and `sessionManager.ts`.

This is preferable to partially changing only `EditorPane`, which caused the current type mismatch.

Then run:

```bash
rtk git add -- src/modules/editor/EditorPane.tsx src/modules/lsp/lib/client.ts
rtk git diff --check
rtk tsc --noEmit
rtk vitest src/modules/editor/lib/eol.test.ts \
  src/modules/editor/lib/externalFormat.test.ts \
  src/modules/editor/lib/indent.test.ts \
  src/modules/editor/lib/autocomplete/normalizeIndent.test.ts \
  src/modules/editor/lib/autocomplete/trimSuggestion.test.ts \
  src/modules/lsp/lib/uri.test.ts
rtk git cherry-pick --continue
```

## Verification already passed

- TypeScript passed after each completed phase before `85a5653`.
- Focused EOL and LSP tests passed.
- Focused filesystem Rust tests passed: 5 tests.
- Improved autocomplete compiled after adapting the Codex integration test with `indentUnit`.
- Diff checks passed at completed checkpoints.
- Branch-creation TypeScript and Rust tests passed.

## Remaining work after `85a5653`

1. Verify whether any upstream editor commits after `85a5653` are still required. The originally selected sequence is now effectively complete through `85a5653`.
2. Remove duplicated editor settings from `GeneralSection` if they still appear there. The dedicated `EditorSection` exists, but General settings were deliberately preserved during conflict resolution to avoid losing fork-only settings.
3. Verify the editor settings UI includes:
   - format on save
   - global formatter
   - per-language formatter overrides
   - custom formatter command
   - autocomplete automatic/manual trigger
   - LSP server controls
4. Verify Codex appears and functions as an autocomplete provider.
5. Verify manual autocomplete shortcut and CodeMirror completion shortcut.
6. Run focused frontend tests.
7. Run Rust filesystem and Git tests.
8. Run full TypeScript.
9. Review the complete branch diff against the pre-backport base.

## Suggested final checks

```bash
rtk tsc --noEmit
rtk vitest src/modules/editor/lib src/modules/lsp/lib
rtk cargo test --manifest-path src-tauri/Cargo.toml modules::fs::file::tests
rtk cargo test --manifest-path src-tauri/Cargo.toml --test git_operations
rtk git diff --check
rtk git status --short --branch
```

The full test suite may still fail only in live Codex integration tests when the local token is expired. Earlier full-suite failures were HTTP 401 responses from expired Codex authentication, plus a pre-existing Tauri `window is not defined` issue from a broad import chain.

## Safety constraints

- Never stage `.wolf/*`.
- Do not accept upstream `store.ts` wholesale; doing so removes fork provider and Codex settings.
- Do not restore upstream spaces architecture.
- Do not restore deleted fork editor/theme files without checking why they were removed.
- Do not broadly run formatting over the repository. Existing Rust formatting differences are unrelated.
- Keep changes surgical and verify each cherry-pick before continuing.
