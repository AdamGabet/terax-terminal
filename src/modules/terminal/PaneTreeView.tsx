import { Fragment } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { SearchAddon } from "@xterm/addon-search";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import { useTerminalDropStore } from "./lib/dropStore";
import type { PaneNode } from "./lib/panes";
import type { TmuxLaunch } from "./lib/pty-bridge";

type LeafBundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onSearch: (addon: SearchAddon) => void;
  onCwd: (cwd: string) => void;
  onExit: (code: number) => void;
};

type Props = {
  node: PaneNode;
  tabVisible: boolean;
  activeLeafId: number;
  onFocusLeaf: (leafId: number) => void;
  onCloseSplitChild: (splitId: number, childIndex: number) => void;
  getBundle: (leafId: number) => LeafBundle;
  tmux?: TmuxLaunch;
};

export function PaneTreeView({
  node,
  tabVisible,
  activeLeafId,
  onFocusLeaf,
  onCloseSplitChild,
  getBundle,
  tmux,
}: Props) {
  if (node.kind === "leaf") {
    const focused = node.id === activeLeafId;
    const b = getBundle(node.id);
    return (
      <div
        onMouseDownCapture={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        // Catches focus from Tab, programmatic focus, or any path that
        // skips mousedown — keeps activeLeafId in sync with DOM focus.
        onFocus={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        data-pane-leaf={node.id}
        className="relative h-full w-full"
      >
        <TerminalPane
          leafId={node.id}
          visible={tabVisible}
          focused={focused}
          initialCwd={node.cwd}
          tmux={tmux}
          ref={b.setRef}
          onSearchReady={(_id, addon) => b.onSearch(addon)}
          onCwd={(_id, cwd) => b.onCwd(cwd)}
          onExit={(_id, code) => b.onExit(code)}
        />
        <DropOverlay leafId={node.id} />
      </div>
    );
  }

  return (
    <ResizablePanelGroup
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <SplitMergeHandle
              dir={node.dir}
              splitId={node.id}
              dividerIndex={i}
              onCloseSplitChild={onCloseSplitChild}
            />
          )}
          <ResizablePanel id={`pane-${child.id}`} minSize="10%">
            <PaneTreeView
              node={child}
              tabVisible={tabVisible}
              activeLeafId={activeLeafId}
              onFocusLeaf={onFocusLeaf}
              onCloseSplitChild={onCloseSplitChild}
              getBundle={getBundle}
              tmux={tmux}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}

function SplitMergeHandle({
  dir,
  splitId,
  dividerIndex,
  onCloseSplitChild,
}: {
  dir: "row" | "col";
  splitId: number;
  dividerIndex: number;
  onCloseSplitChild: (splitId: number, childIndex: number) => void;
}) {
  const keepBefore = dir === "row" ? "Keep left" : "Keep top";
  const keepAfter = dir === "row" ? "Keep right" : "Keep bottom";
  return (
    <ResizableHandle>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-label="Merge split panes"
            title="Right-click to merge split panes"
            className="z-10 grid size-4 shrink-0 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="size-1.5 rounded-full bg-current" />
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-32">
          <ContextMenuItem
            onSelect={() => onCloseSplitChild(splitId, dividerIndex)}
          >
            {keepBefore}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => onCloseSplitChild(splitId, dividerIndex - 1)}
          >
            {keepAfter}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </ResizableHandle>
  );
}

function DropOverlay({ leafId }: { leafId: number }) {
  const active = useTerminalDropStore((s) => s.targetLeafId === leafId);
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-primary/45 bg-background/70 text-xs font-medium text-foreground shadow-lg backdrop-blur-sm">
      Drop file path here
    </div>
  );
}
