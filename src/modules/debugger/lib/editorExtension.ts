import { type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutter,
  GutterMarker,
  ViewPlugin,
} from "@codemirror/view";
import { remapProbeLines } from "./probeRemap";
import { useDebuggerStore } from "./store";
import type { Probe } from "./types";

const setProbes = StateEffect.define<Probe[]>();
const setPausedLine = StateEffect.define<number | null>();

const probesField = StateField.define<Probe[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setProbes)) value = e.value;
    return value;
  },
});

const pausedLineField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPausedLine)) value = e.value;
    return value;
  },
});

class ProbeMarker extends GutterMarker {
  constructor(
    private kind: Probe["kind"],
    private enabled: boolean,
  ) {
    super();
  }
  override eq(other: ProbeMarker) {
    return other.kind === this.kind && other.enabled === this.enabled;
  }
  override toDOM() {
    const el = document.createElement("span");
    el.className = `cm-terax-probe cm-terax-probe-${this.kind}${
      this.enabled ? "" : " cm-terax-probe-off"
    }`;
    el.textContent = this.kind === "break" ? "●" : "◆";
    return el;
  }
}

const pausedLineDeco = Decoration.line({ class: "cm-terax-paused-line" });

const pausedDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_deco, tr) {
    const line = tr.state.field(pausedLineField);
    if (line == null || line > tr.state.doc.lines) return Decoration.none;
    const from = tr.state.doc.line(line).from;
    return Decoration.set([pausedLineDeco.range(from)]);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.baseTheme({
  ".cm-terax-bp-gutter": {
    width: "14px",
    cursor: "pointer",
  },
  ".cm-terax-probe": {
    display: "inline-block",
    width: "100%",
    textAlign: "center",
    fontSize: "10px",
    lineHeight: "1.4",
  },
  ".cm-terax-probe-break": { color: "#ef4444" },
  ".cm-terax-probe-trace": { color: "#0ea5e9" },
  ".cm-terax-probe-off": { opacity: "0.4" },
  ".cm-terax-paused-line": {
    backgroundColor: "rgba(245, 158, 11, 0.14)",
  },
});

/**
 * Editor integration: probe gutter (click = breakpoint, Alt/⌥-click =
 * tracepoint) + paused-line highlight, kept in sync with the debugger store.
 */
export function debuggerEditorExtension(getPath: () => string): Extension {
  const sync = ViewPlugin.define((view) => {
    let lastPausedLine: number | null = null;
    let lastProbes: Probe[] | null = null;
    const push = () => {
      const path = getPath();
      const st = useDebuggerStore.getState();
      const probes = st.probes[path] ?? [];
      const frame = st.paused?.frames[st.paused.selectedFrame];
      const line =
        st.status === "paused" && frame?.source?.path === path
          ? frame.line
          : null;
      // Compare before set: remapProbes (below) re-enters through this
      // subscription — identical state must not dispatch again.
      if (probes === lastProbes && line === lastPausedLine) return;
      lastProbes = probes;
      const effects: StateEffect<unknown>[] = [
        setProbes.of(probes),
        setPausedLine.of(line),
      ];
      if (
        line != null &&
        line !== lastPausedLine &&
        line <= view.state.doc.lines
      ) {
        effects.push(
          EditorView.scrollIntoView(view.state.doc.line(line).from, {
            y: "center",
          }),
        );
      }
      lastPausedLine = line;
      view.dispatch({ effects });
    };
    const unsub = useDebuggerStore.subscribe(push);
    const kick = setTimeout(push, 0);
    return {
      // Probe line drift: follow document edits so probes stick to their
      // statement instead of their original line number.
      update: (u) => {
        if (!u.docChanged) return;
        const path = getPath();
        const st = useDebuggerStore.getState();
        const probes = st.probes[path];
        if (!probes || probes.length === 0) return;
        const { moves, dropped } = remapProbeLines(
          probes.map((p) => p.line),
          u.changes,
          u.startState.doc,
          u.state.doc,
        );
        if (moves.length === 0 && dropped.length === 0) return;
        // The store mutation re-enters push() → view.dispatch, which is
        // illegal inside an update cycle — defer past it.
        queueMicrotask(() => st.remapProbes(path, moves, dropped));
      },
      destroy: () => {
        unsub();
        clearTimeout(kick);
      },
    };
  });

  const bpGutter = gutter({
    class: "cm-terax-bp-gutter",
    lineMarker(view, blockLine) {
      const probes = view.state.field(probesField);
      if (probes.length === 0) return null;
      const lineNo = view.state.doc.lineAt(blockLine.from).number;
      const probe = probes.find((p) => p.line === lineNo);
      return probe ? new ProbeMarker(probe.kind, probe.enabled) : null;
    },
    lineMarkerChange: (update) =>
      update.transactions.some((tr) => tr.effects.some((e) => e.is(setProbes))),
    domEventHandlers: {
      mousedown(view, blockLine, event) {
        const path = getPath();
        if (!path.endsWith(".py")) return false;
        if ((event as MouseEvent).button !== 0) return false;
        const lineNo = view.state.doc.lineAt(blockLine.from).number;
        const kind = (event as MouseEvent).altKey ? "trace" : "break";
        useDebuggerStore.getState().toggleProbe(path, lineNo, kind);
        return true;
      },
      contextmenu(view, blockLine, event) {
        const path = getPath();
        if (!path.endsWith(".py")) return false;
        event.preventDefault();
        const lineNo = view.state.doc.lineAt(blockLine.from).number;
        const st = useDebuggerStore.getState();
        const existing = (st.probes[path] ?? []).find((p) => p.line === lineNo);
        if (!existing) st.upsertProbe(path, lineNo, "break");
        const e = event as MouseEvent;
        st.setProbeEditor({
          file: path,
          line: lineNo,
          x: e.clientX,
          y: e.clientY,
        });
        return true;
      },
    },
  });

  return [probesField, pausedLineField, pausedDecoField, theme, bpGutter, sync];
}
