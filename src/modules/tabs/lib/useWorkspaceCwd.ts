import { useCallback, useMemo, useRef } from "react";
import type { Tab } from "./useTabs";

type Result = {
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
};

export function useWorkspaceCwd(
  activeTab: Tab | undefined,
  tabs: Tab[],
  home: string | null,
  contextualRoot?: string | null,
): Result {
  const lastTerminalCwd = useRef<string | null>(null);

  if (activeTab?.kind === "terminal" && activeTab.cwd) {
    lastTerminalCwd.current = activeTab.cwd;
  }

  const explorerRoot = useMemo<string | null>(() => {
    if (activeTab?.kind === "terminal" && activeTab.cwd) return activeTab.cwd;
    if (contextualRoot) return contextualRoot;
    if (lastTerminalCwd.current) return lastTerminalCwd.current;
    const anyTerm = tabs.find((t) => t.kind === "terminal" && t.cwd);
    if (anyTerm?.kind === "terminal" && anyTerm.cwd) return anyTerm.cwd;
    return home;
  }, [activeTab, tabs, home, contextualRoot]);

  const inheritedCwdForNewTab = useCallback((): string | undefined => {
    if (activeTab?.kind === "terminal" && activeTab.cwd) return activeTab.cwd;
    // A Finder-opened file deliberately sets contextualRoot; otherwise editor
    // tabs keep the last terminal's cwd instead of adopting the file's folder.
    return contextualRoot ?? lastTerminalCwd.current ?? home ?? undefined;
  }, [activeTab, home, contextualRoot]);

  return { explorerRoot, inheritedCwdForNewTab };
}
