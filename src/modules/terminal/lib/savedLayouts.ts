import type { TerminalTab } from "@/modules/tabs";
import type { WorkspaceEnv } from "@/modules/workspace";
import type { PaneNode } from "./panes";

const STORAGE_KEY = "terax.saved-terminal-layouts.v1";
const MAX_LAYOUTS = 50;
const MAX_TABS = 20;
const MAX_PANES = 4;

export const DEFAULT_RESTART_ALLOWLIST = [
  "bash",
  "claude",
  "opencode",
  "codex",
];

export type SavedPaneNode =
  | {
      kind: "leaf";
      cwd?: string;
      restartShell?: string;
      restartCommand?: string;
    }
  | { kind: "split"; dir: "row" | "col"; children: SavedPaneNode[] };

export type SavedTerminalTab = {
  title: string;
  customTitle?: string;
  private?: boolean;
  paneTree: SavedPaneNode;
  activeLeafIndex: number;
};

export type SavedTerminalLayout = {
  id: string;
  name: string;
  createdAt: number;
  workspace: WorkspaceEnv;
  tabs: SavedTerminalTab[];
  activeTabIndex: number;
};

export type SavedLayoutsState = {
  restartAllowlist: string[];
  layouts: SavedTerminalLayout[];
};

export function normalizeRestartAllowlist(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const command = value.trim().toLowerCase();
    if (!/^[a-z0-9._+-]+$/.test(command) || out.includes(command)) continue;
    out.push(command);
  }
  return out;
}

const NESTED_SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh"]);

function commandExecutable(
  commandLine: string | null | undefined,
): string | null {
  if (!commandLine) return null;
  const first = commandLine
    .trim()
    .match(/^(?:exec\s+)?(?:["']?)([^\s"']+)/)?.[1];
  return first ? (first.split(/[\\/]/).pop() ?? "").toLowerCase() : null;
}

export function allowedExecutable(
  commandLine: string | null | undefined,
  allowlist: string[],
): string | null {
  const executable = commandExecutable(commandLine);
  return executable && normalizeRestartAllowlist(allowlist).includes(executable)
    ? executable
    : null;
}

// A shell started from the prompt inherits none of Terax's shell integration,
// so it never emits a shell marker. The only trace left is the outer shell's
// preexec line, which still names the shell that took over the pane.
export function nestedShellFor(
  commandLine: string | null | undefined,
): string | null {
  const executable = commandExecutable(commandLine);
  return executable && NESTED_SHELLS.has(executable) ? executable : null;
}

export function restoredLaunchStep(
  observedShell: string | null,
  restartShell?: string,
  restartCommand?: string,
): { write: string | null; complete: boolean } {
  if (!observedShell) return { write: null, complete: false };
  const command = restartCommand ? `${restartCommand}\r` : null;
  if (restartShell && restartShell !== observedShell) {
    // An unintegrated shell will never announce itself, so waiting for a second
    // shell marker would strand the saved command. Chain both onto one write and
    // let the tty hold the command until the new shell reads it.
    return { write: `${restartShell}\r${command ?? ""}`, complete: true };
  }
  return { write: command, complete: true };
}

export function lastShellMarker(data: string): string | null {
  const pattern = /\x1b\]133;S;([a-z0-9._+-]+)(?:\x07|\x1b\\)/g;
  let shell: string | null = null;
  for (const match of data.matchAll(pattern)) shell = match[1];
  return shell;
}

function savePane(
  node: PaneNode,
  shellForLeaf: (leafId: number) => string | null,
  commandForLeaf: (leafId: number) => string | null,
): SavedPaneNode {
  if (node.kind === "leaf") {
    const restartShell = shellForLeaf(node.id);
    const restartCommand = commandForLeaf(node.id);
    return {
      kind: "leaf",
      ...(node.cwd && { cwd: node.cwd }),
      ...(restartShell && { restartShell }),
      ...(restartCommand && { restartCommand }),
    };
  }
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.map((child) =>
      savePane(child, shellForLeaf, commandForLeaf),
    ),
  };
}

export function createSavedLayout(
  name: string,
  workspace: WorkspaceEnv,
  tabs: TerminalTab[],
  activeTabId: number,
  shellForLeaf: (leafId: number) => string | null,
  commandForLeaf: (leafId: number) => string | null,
): SavedTerminalLayout {
  const activeTabIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeTabId),
  );
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    createdAt: Date.now(),
    workspace,
    tabs: tabs.map((tab) => {
      const ids = leafIdsInOrder(tab.paneTree);
      return {
        title: tab.title,
        ...(tab.customTitle && { customTitle: tab.customTitle }),
        ...(tab.private && { private: true }),
        paneTree: savePane(
          tab.paneTree,
          tab.private ? () => null : shellForLeaf,
          tab.private ? () => null : commandForLeaf,
        ),
        activeLeafIndex: Math.max(0, ids.indexOf(tab.activeLeafId)),
      };
    }),
    activeTabIndex,
  };
}

function leafIdsInOrder(node: PaneNode): number[] {
  return node.kind === "leaf"
    ? [node.id]
    : node.children.flatMap(leafIdsInOrder);
}

export function loadSavedLayoutsState(): SavedLayoutsState {
  try {
    return parseSavedLayoutsState(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { restartAllowlist: DEFAULT_RESTART_ALLOWLIST, layouts: [] };
  }
}

export function persistSavedLayoutsState(state: SavedLayoutsState): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        restartAllowlist: normalizeRestartAllowlist(state.restartAllowlist),
        layouts: state.layouts.slice(0, MAX_LAYOUTS),
      }),
    );
  } catch {
    // Storage can be unavailable in private webviews.
  }
}

export function parseSavedLayoutsState(raw: string | null): SavedLayoutsState {
  if (!raw) return { restartAllowlist: DEFAULT_RESTART_ALLOWLIST, layouts: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { restartAllowlist: DEFAULT_RESTART_ALLOWLIST, layouts: [] };
  }
  if (!isRecord(value)) {
    return { restartAllowlist: DEFAULT_RESTART_ALLOWLIST, layouts: [] };
  }
  const restartAllowlist = Array.isArray(value.restartAllowlist)
    ? normalizeRestartAllowlist(
        value.restartAllowlist.filter(
          (item): item is string => typeof item === "string",
        ),
      )
    : DEFAULT_RESTART_ALLOWLIST;
  const layouts = Array.isArray(value.layouts)
    ? value.layouts
        .slice(0, MAX_LAYOUTS)
        .map(parseLayout)
        .filter((layout): layout is SavedTerminalLayout => layout !== null)
    : [];
  return { restartAllowlist, layouts };
}

function parseLayout(value: unknown): SavedTerminalLayout | null {
  if (!isRecord(value)) return null;
  const workspace = parseWorkspace(value.workspace);
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.createdAt !== "number" ||
    !workspace ||
    !Array.isArray(value.tabs) ||
    value.tabs.length === 0 ||
    value.tabs.length > MAX_TABS
  ) {
    return null;
  }
  const tabs = value.tabs.map(parseTab);
  if (tabs.some((tab) => tab === null)) return null;
  const activeTabIndex = boundedIndex(value.activeTabIndex, tabs.length);
  return {
    id: value.id,
    name: value.name.trim(),
    createdAt: value.createdAt,
    workspace,
    tabs: tabs as SavedTerminalTab[],
    activeTabIndex,
  };
}

function parseTab(value: unknown): SavedTerminalTab | null {
  if (!isRecord(value) || typeof value.title !== "string") return null;
  const paneTree = parsePane(value.paneTree);
  if (!paneTree || countLeaves(paneTree) > MAX_PANES) return null;
  return {
    title: value.title,
    ...(typeof value.customTitle === "string" && value.customTitle
      ? { customTitle: value.customTitle }
      : {}),
    ...(value.private === true && { private: true }),
    paneTree,
    activeLeafIndex: boundedIndex(value.activeLeafIndex, countLeaves(paneTree)),
  };
}

function parsePane(value: unknown, depth = 0): SavedPaneNode | null {
  if (!isRecord(value) || depth > MAX_PANES) return null;
  if (value.kind === "leaf") {
    return {
      kind: "leaf",
      ...(typeof value.cwd === "string" && value.cwd ? { cwd: value.cwd } : {}),
      ...(typeof value.restartCommand === "string" &&
      /^[a-z0-9._+-]+$/.test(value.restartCommand)
        ? { restartCommand: value.restartCommand }
        : {}),
      ...(typeof value.restartShell === "string" &&
      /^[a-z0-9._+-]+$/.test(value.restartShell)
        ? { restartShell: value.restartShell }
        : {}),
    };
  }
  if (
    value.kind !== "split" ||
    (value.dir !== "row" && value.dir !== "col") ||
    !Array.isArray(value.children) ||
    value.children.length < 2 ||
    value.children.length > MAX_PANES
  ) {
    return null;
  }
  const children = value.children.map((child) => parsePane(child, depth + 1));
  if (children.some((child) => child === null)) return null;
  return {
    kind: "split",
    dir: value.dir,
    children: children as SavedPaneNode[],
  };
}

function parseWorkspace(value: unknown): WorkspaceEnv | null {
  if (!isRecord(value)) return null;
  if (value.kind === "local") return { kind: "local" };
  if (
    value.kind === "wsl" &&
    typeof value.distro === "string" &&
    value.distro
  ) {
    return { kind: "wsl", distro: value.distro };
  }
  if (value.kind === "ssh" && typeof value.host === "string" && value.host) {
    return {
      kind: "ssh",
      host: value.host,
      ...(value.platform === "posix" || value.platform === "windows"
        ? { platform: value.platform }
        : {}),
    };
  }
  return null;
}

function countLeaves(node: SavedPaneNode): number {
  return node.kind === "leaf"
    ? 1
    : node.children.reduce((total, child) => total + countLeaves(child), 0);
}

function boundedIndex(value: unknown, length: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(0, Math.min(value, length - 1))
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
