import { indentUnit } from "@codemirror/language";
import { Compartment, type Extension, type Text } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin } from "@codemirror/view";
import {
  LanguageServerClient,
  languageServerPlugin,
  renameSymbol,
} from "codemirror-languageserver";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type KeyBinding,
  SHORTCUTS,
  type ShortcutId,
} from "@/modules/shortcuts/shortcuts";

/** Effective bindings for a shortcut: the user's override if set, else the
 * registry default. Mirrors the resolution in useGlobalShortcuts. */
function bindingsFor(id: ShortcutId): KeyBinding[] {
  const user = usePreferencesStore.getState().shortcuts[id];
  if (user !== undefined) return user;
  return SHORTCUTS.find((s) => s.id === id)?.defaultBindings ?? [];
}

/** KeyBinding → CodeMirror keymap notation, e.g. "Shift-Alt-f", "F12". */
function bindingToCodeMirrorKey(b: KeyBinding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push("Ctrl");
  if (b.meta) parts.push("Meta");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  parts.push(b.key.length === 1 ? b.key.toLowerCase() : b.key);
  return parts.join("-");
}

export {
  languageServerWithTransport,
  SynchronizationMethod,
} from "codemirror-languageserver";

type LspPos = { line: number; character: number };
type LspRange = { start: LspPos };

function offsetOf(doc: Text, pos: LspPos): number {
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1);
  return Math.min(line.from + pos.character, line.to);
}

// The lib's formatDocument command fires and forgets; save needs to await
// the edits before writing to disk.
export async function formatDocumentAndWait(
  view: EditorView,
): Promise<boolean> {
  const plugin = view.plugin(languageServerPlugin);
  if (!plugin) return false;
  const { client } = plugin;
  if (!client.ready || !client.capabilities?.documentFormattingProvider) {
    return false;
  }
  const doc = view.state.doc;
  const edits = await client.textDocumentFormatting({
    textDocument: { uri: plugin.documentUri },
    options: {
      tabSize: view.state.tabSize,
      insertSpaces: view.state.facet(indentUnit) !== "\t",
    },
  });
  if (!edits || edits.length === 0) return false;
  // Edits are offsets into the requested snapshot; typing during the
  // round-trip would corrupt the document.
  if (view.state.doc !== doc) return false;
  view.dispatch({
    changes: edits.map((e) => ({
      from: offsetOf(doc, e.range.start),
      to: offsetOf(doc, e.range.end),
      insert: e.newText,
    })),
  });
  return true;
}

export function lspInteractions(opts: {
  client: TeraxLspClient;
  documentUri: string;
  onExternal: (uri: string, line: number) => void;
}): Extension {
  const gotoDefinition = async (
    view: EditorView,
    pos: number,
  ): Promise<void> => {
    const line = view.state.doc.lineAt(pos);
    let result: Awaited<
      ReturnType<LanguageServerClient["textDocumentDefinition"]>
    >;
    try {
      result = await opts.client.textDocumentDefinition({
        textDocument: { uri: opts.documentUri },
        position: { line: line.number - 1, character: pos - line.from },
      });
    } catch {
      return;
    }
    const loc = Array.isArray(result) ? result[0] : result;
    if (!loc) return;
    const uri = "uri" in loc ? loc.uri : loc.targetUri;
    const range: LspRange | undefined =
      "range" in loc
        ? loc.range
        : (loc.targetSelectionRange ?? loc.targetRange);
    if (!uri || !range) return;
    if (uri === opts.documentUri) {
      const targetLine = Math.min(range.start.line + 1, view.state.doc.lines);
      const target = Math.min(
        view.state.doc.line(targetLine).from + range.start.character,
        view.state.doc.length,
      );
      view.dispatch({
        selection: { anchor: target },
        effects: EditorView.scrollIntoView(target, { y: "center" }),
      });
      view.focus();
    } else {
      opts.onExternal(uri, range.start.line + 1);
    }
  };

  const gotoRun = (view: EditorView): boolean => {
    void gotoDefinition(view, view.state.selection.main.head);
    return true;
  };
  const formatRun = (view: EditorView): boolean => {
    void formatDocumentAndWait(view);
    return true;
  };

  const buildKeymap = (): Extension =>
    keymap.of([
      ...bindingsFor("lsp.gotoDefinition").map((b) => ({
        key: bindingToCodeMirrorKey(b),
        preventDefault: true,
        run: gotoRun,
      })),
      ...bindingsFor("lsp.rename").map((b) => ({
        key: bindingToCodeMirrorKey(b),
        preventDefault: true,
        run: renameSymbol,
      })),
      ...bindingsFor("lsp.formatDocument").map((b) => ({
        key: bindingToCodeMirrorKey(b),
        preventDefault: true,
        run: formatRun,
      })),
    ]);

  // The keymap lives in a compartment so rebinding in Settings → Shortcuts
  // reconfigures the open editor immediately, without reopening the file.
  const keymapCompartment = new Compartment();
  const rebindOnPrefsChange = ViewPlugin.define((view) => {
    const unsub = usePreferencesStore.subscribe((state, prev) => {
      if (state.shortcuts === prev.shortcuts) return;
      view.dispatch({ effects: keymapCompartment.reconfigure(buildKeymap()) });
    });
    return { destroy: unsub };
  });

  return [
    keymapCompartment.of(buildKeymap()),
    rebindOnPrefsChange,
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0) {
          return false;
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        void gotoDefinition(view, pos);
        return true;
      },
    }),
  ];
}

type RawRpc = {
  notify(method: string, params: unknown): Promise<void>;
  request(method: string, params: unknown, timeout: number): Promise<unknown>;
};

// The lib's notify/request maps omit didClose, didSave and the
// shutdown/exit handshake; servers need all three for correct lifecycle.
export class TeraxLspClient extends LanguageServerClient {
  static hostPid: number | null = null;
  /** Set right before constructing a client for an SSH workspace: the server
   * runs on the remote host where the local app's PID is meaningless, so its
   * parent-exit watchdog must be disabled (processId: null). Read synchronously
   * inside `getInitializeParams`, which the parent constructor invokes before
   * the constructing frame yields — so no instance field would be set yet. */
  static nextRemote = false;

  // The lib omits the publishDiagnostics capability and servers like
  // typescript-language-server push no diagnostics without it. processId
  // enables the server-side parent watchdog (local only; null over SSH).
  // Read the static, not an instance field: the parent constructor calls this
  // during super(), before any subclass field initializer has run.
  protected override getInitializeParams() {
    const params = super.getInitializeParams();
    params.processId = TeraxLspClient.nextRemote
      ? null
      : TeraxLspClient.hostPid;
    params.capabilities.textDocument = {
      ...params.capabilities.textDocument,
      publishDiagnostics: { relatedInformation: true },
    };
    return params;
  }

  textDocumentDidClose(uri: string): void {
    void this.raw.notify("textDocument/didClose", { textDocument: { uri } });
  }

  textDocumentDidSave(uri: string): void {
    void this.raw.notify("textDocument/didSave", { textDocument: { uri } });
  }

  async shutdownGracefully(timeoutMs = 2000): Promise<void> {
    try {
      await this.raw.request("shutdown", null, timeoutMs);
      await this.raw.notify("exit", null);
    } catch {
      // Server already dead or unresponsive; the transport kill follows.
    }
  }

  private get raw(): RawRpc {
    return this as unknown as RawRpc;
  }
}
