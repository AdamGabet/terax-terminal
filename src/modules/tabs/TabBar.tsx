import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtShortcut, IS_MAC, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  ALL_LANGUAGES,
  EXPOSED_LANGUAGES,
} from "@/modules/editor/lib/languageDefinitions";
import { resolveDisplayName } from "@/modules/editor/lib/languageResolver";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  Cancel01Icon,
  Clock01Icon,
  ComputerTerminal02Icon,
  GitBranchIcon,
  GitCompareIcon,
  Globe02Icon,
  HierarchySquare01Icon,
  IncognitoIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import {
  copyToClipboard,
  relativePath,
} from "@/modules/explorer/lib/contextActions";
import { isPreviewTab } from "./lib/fileTabs";
import { labelFor } from "./lib/tabLabel";
import type { EditorTab, Tab } from "./lib/useTabs";

/** The file path (or terminal cwd) a tab maps to, for copy-path actions. */
function tabPath(tab: Tab): string | null {
  if (tab.kind === "terminal") return tab.cwd ?? null;
  if (
    tab.kind === "editor" ||
    tab.kind === "markdown" ||
    tab.kind === "file-preview" ||
    tab.kind === "ai-diff" ||
    tab.kind === "git-diff" ||
    tab.kind === "git-commit-file"
  ) {
    return tab.path;
  }
  return null;
}

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewPrivate: () => void;
  onNewTmux: () => void;
  tmuxAvailable: boolean;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onNewFleet: () => void;
  /** `force` skips the unsaved-changes / running-process confirmations. */
  onClose: (id: number, opts?: { force?: boolean }) => void;
  /** Pin (promote) a preview tab to persistent on double-click. */
  onPin: (id: number) => void;
  /** Set a terminal tab's custom label; empty string resets to default. */
  onRename: (id: number, title: string) => void;
  /** Move tab `fromId` before `beforeId`; `null` moves it to the end. */
  onReorder: (fromId: number, beforeId: number | null) => void;
  /** Workspace root, for the "Copy Relative Path" action. */
  rootPath?: string | null;
  onOverrideLanguage?: (id: number, lang: string | null) => void;
  compact?: boolean;
};

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onNew,
  onNewPrivate,
  onNewTmux,
  tmuxAvailable,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onNewFleet,
  onClose,
  onPin,
  onRename,
  onReorder,
  rootPath,
  onOverrideLanguage,
  compact,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  // Set when "Rename" is picked so the closing context menu doesn't hand focus
  // back to the terminal and blur (cancel) the freshly opened rename input.
  const renamingRef = useRef(false);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  // Tracks an in-progress pointer drag; `moved` flips true once past the
  // threshold.
  const dragRef = useRef<{ id: number; startX: number; moved: boolean } | null>(
    null,
  );
  const [showAllLanguages, setShowAllLanguages] = useState(false);
  // Set when a drag just ended, so the trailing `click` is swallowed (dragRef
  // is already null by the time it fires). Cleared by that click or next down.
  const justDraggedRef = useRef(false);

  const onTabPointerDown = (e: React.PointerEvent, id: number) => {
    if (e.button !== 0) return;
    justDraggedRef.current = false;
    dragRef.current = { id, startX: e.clientX, moved: false };
  };

  const onTabPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) < 5) return;
      d.moved = true;
      setDraggingId(d.id);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    // Drop before the first tab whose horizontal midpoint sits past the
    // pointer; past the last tab means append (beforeId = null).
    const els =
      scrollRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]");
    if (!els) return;
    let beforeId: number | null = null;
    for (const el of els) {
      const tid = Number(el.dataset.tabId);
      if (tid === d.id) continue;
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        beforeId = tid;
        break;
      }
    }
    onReorder(d.id, beforeId);
  };

  const endTabDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved) {
      justDraggedRef.current = true;
      setDraggingId(null);
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    }
  };

  // Horizontal wheel scroll without holding shift.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab visible after selection / open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  return (
    <div
      ref={scrollRef}
      data-tauri-drag-region
      className="min-w-0 shrink overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max items-center gap-0.5">
        <Tabs
          value={String(activeId)}
          onValueChange={(v) => onSelect(Number(v))}
        >
          <TabsList className="h-7 w-max gap-0.5 bg-transparent p-0">
            {tabs.map((t) => {
              const isPreview = isPreviewTab(t);

              // While renaming, render a non-button cell so the <input> is not
              // nested inside the trigger <button> (invalid HTML, and WebKit
              // blocks focus/selection on inputs inside buttons).
              if (editingId === t.id && t.kind === "terminal") {
                return (
                  <div
                    key={t.id}
                    data-tab-id={t.id}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent text-xs text-foreground",
                      compact ? "px-1.5" : "px-2",
                    )}
                  >
                    <TabIcon tab={t} />
                    <TabRenameInput
                      initial={labelFor(t)}
                      onCommit={(value) => {
                        onRename(t.id, value);
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  </div>
                );
              }

              const trigger = (
                <TabsTrigger
                  key={t.id}
                  value={String(t.id)}
                  data-tab-id={t.id}
                  onDoubleClick={() => isPreview && onPin(t.id)}
                  onAuxClick={(e) => {
                    if (e.button === 1 && tabs.length > 1) {
                      e.preventDefault();
                      e.stopPropagation();
                      onClose(t.id);
                    }
                  }}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      return;
                    }
                    if (
                      e.button === 0 &&
                      !(e.target as HTMLElement).closest("[data-no-drag]")
                    ) {
                      e.preventDefault();
                    }
                  }}
                  onPointerDown={(e) => onTabPointerDown(e, t.id)}
                  onPointerMove={onTabPointerMove}
                  onPointerUp={(e) => {
                    const drag = dragRef.current;
                    if (drag && !drag.moved && t.id !== activeId)
                      onSelect(t.id);
                    endTabDrag(e);
                  }}
                  onPointerCancel={endTabDrag}
                  onClickCapture={(e) => {
                    // Swallow the click that trails a real drag so it doesn't
                    // re-select the tab (dragRef is already null by now).
                    if (justDraggedRef.current) {
                      justDraggedRef.current = false;
                      e.preventDefault();
                      e.stopPropagation();
                    }
                  }}
                  className={cn(
                    "group h-7 shrink-0 gap-1.5 rounded-md text-xs text-muted-foreground transition-colors data-[state=active]:bg-accent data-[state=active]:text-foreground hover:text-foreground/80 justify-between",
                    draggingId === t.id && "opacity-60",
                    compact
                      ? "px-1.5!"
                      : tabs.length === 1
                        ? "px-2!"
                        : "ps-2! pe-1!",
                  )}
                >
                  <span
                    className={cn(
                      "flex min-w-0 items-center gap-1.5",
                      compact ? "max-w-48" : "max-w-80",
                    )}
                  >
                    {t.kind === "editor" ? (
                      <DropdownMenu
                        onOpenChange={(open) => {
                          if (!open) setShowAllLanguages(false);
                        }}
                      >
                        <DropdownMenuTrigger asChild>
                          {/* span, not button: a button nested in the TabsTrigger button is invalid DOM and breaks WebKit focus. */}
                          <span
                            role="button"
                            tabIndex={-1}
                            data-no-drag
                            className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm p-1 -m-1 transition-all hover:bg-accent hover:text-accent-foreground hover:ring-1 hover:ring-primary/30 hover:shadow-[0_0_4px_var(--color-popover-foreground)]"
                          >
                            <TabIcon tab={t} />
                          </span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          side="bottom"
                          sideOffset={6}
                          alignOffset={-4}
                          className="max-h-75 w-48 overflow-y-auto rounded-xl border border-border/40 bg-popover/90 p-1 backdrop-blur-md shadow-lg"
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => e.stopPropagation()}
                          onPointerUp={(e) => e.stopPropagation()}
                        >
                          <DropdownMenuItem
                            onSelect={() => {
                              onOverrideLanguage?.(t.id, null);
                            }}
                            className="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-lg cursor-default focus:bg-accent focus:text-accent-foreground"
                          >
                            <img
                              src={fileIconUrl(t.title)}
                              className="size-3.5 shrink-0 object-contain"
                              alt=""
                            />
                            <div className="flex flex-1 flex-col">
                              <span>Auto Detect</span>
                              <span className="text-[10px] text-muted-foreground italic">
                                Mode: {resolveDisplayName(t.title)}
                              </span>
                            </div>
                            {!(t as EditorTab).overrideLanguage && (
                              <HugeiconsIcon
                                icon={Tick02Icon}
                                className="size-3.5 text-primary"
                              />
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={(e) => {
                              e.preventDefault();
                              setShowAllLanguages((v) => !v);
                            }}
                            className="w-full px-2.5 py-1.5 text-left text-xs text-primary/60 hover:text-primary rounded-lg transition-colors hover:bg-accent"
                          >
                            {showAllLanguages
                              ? "↑ Fewer languages"
                              : "↓ All languages"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator className="my-1 border-t border-border/30" />
                          {(showAllLanguages
                            ? ALL_LANGUAGES
                            : EXPOSED_LANGUAGES
                          ).map((lang) => {
                            const isSelected =
                              (t as EditorTab).overrideLanguage === lang.ext;
                            return (
                              <DropdownMenuItem
                                key={lang.ext}
                                onSelect={() =>
                                  onOverrideLanguage?.(t.id, lang.ext)
                                }
                                className="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-lg cursor-default focus:bg-accent focus:text-accent-foreground"
                              >
                                <img
                                  src={fileIconUrl(`dummy.${lang.ext}`)}
                                  className="size-3.5 shrink-0 object-contain"
                                  alt=""
                                />
                                <span className="flex-1">{lang.name}</span>
                                {isSelected && (
                                  <HugeiconsIcon
                                    icon={Tick02Icon}
                                    className="size-3.5 text-primary"
                                  />
                                )}
                              </DropdownMenuItem>
                            );
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <TabIcon tab={t} />
                    )}
                    {/* Preview tabs use italic to signal the transient state,
                        matching the visual convention from VSCode. */}
                    <span className={cn("truncate", isPreview && "italic")}>
                      {labelFor(t)}
                    </span>
                    {t.kind === "editor" && t.dirty ? (
                      <span
                        aria-label="Unsaved changes"
                        className="size-1.5 shrink-0 rounded-full bg-foreground/70"
                      />
                    ) : null}
                  </span>
                  {tabs.length > 1 && (
                    <span
                      role="button"
                      data-no-drag
                      aria-label="Close tab"
                      title={`Close (${MOD_KEY}-click: without asking)`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(t.id, {
                          force: IS_MAC ? e.metaKey : e.ctrlKey,
                        });
                      }}
                      className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent hover:opacity-100 group-hover:opacity-60"
                    >
                      <HugeiconsIcon
                        icon={Cancel01Icon}
                        size={11}
                        strokeWidth={2}
                      />
                    </span>
                  )}
                </TabsTrigger>
              );

              const path = tabPath(t);
              // Nothing actionable → skip the (empty) menu wrapper entirely.
              if (t.kind !== "terminal" && !path && tabs.length <= 1) {
                return trigger;
              }

              return (
                <ContextMenu key={t.id}>
                  <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
                  <ContextMenuContent
                    className="min-w-36"
                    onCloseAutoFocus={(e) => {
                      if (!renamingRef.current) return;
                      renamingRef.current = false;
                      e.preventDefault();
                    }}
                  >
                    {t.kind === "terminal" && (
                      <ContextMenuItem
                        onSelect={() => {
                          renamingRef.current = true;
                          setEditingId(t.id);
                        }}
                      >
                        <HugeiconsIcon
                          icon={PencilEdit02Icon}
                          size={14}
                          strokeWidth={1.75}
                        />
                        <span className="flex-1">Rename</span>
                      </ContextMenuItem>
                    )}
                    {path && (
                      <>
                        {t.kind === "terminal" && <ContextMenuSeparator />}
                        <ContextMenuItem
                          onSelect={() => void copyToClipboard(path)}
                        >
                          <span className="flex-1">Copy Path</span>
                        </ContextMenuItem>
                        <ContextMenuItem
                          onSelect={() =>
                            void copyToClipboard(
                              rootPath ? relativePath(rootPath, path) : path,
                            )
                          }
                        >
                          <span className="flex-1">Copy Relative Path</span>
                        </ContextMenuItem>
                      </>
                    )}
                    {tabs.length > 1 && (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => onClose(t.id)}>
                          <HugeiconsIcon
                            icon={Cancel01Icon}
                            size={14}
                            strokeWidth={1.75}
                          />
                          <span className="flex-1">Close</span>
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </TabsList>
        </Tabs>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="New tab"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuItem onSelect={() => onNew()}>
              <HugeiconsIcon
                icon={ComputerTerminal02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Terminal</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "T")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPrivate()}>
              <HugeiconsIcon
                icon={IncognitoIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Privacy</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "R")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!tmuxAvailable}
              onSelect={() => onNewTmux()}
              title={
                tmuxAvailable
                  ? undefined
                  : "Install tmux to enable persistent terminals"
              }
            >
              <HugeiconsIcon
                icon={ComputerTerminal02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Tmux Term</span>
              {!tmuxAvailable && (
                <span className="text-xs text-muted-foreground">
                  not installed
                </span>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewEditor()}>
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Editor</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "E")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPreview()}>
              <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Preview</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "P")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewGitGraph()}>
              <HugeiconsIcon
                icon={GitBranchIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Git Graph</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewFleet()}>
              <HugeiconsIcon
                icon={HierarchySquare01Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Fleet / Orchestrator</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function TabIcon({ tab }: { tab: Tab }) {
  if (
    tab.kind === "editor" ||
    tab.kind === "markdown" ||
    tab.kind === "file-preview"
  ) {
    const url =
      tab.kind === "editor" && tab.overrideLanguage
        ? fileIconUrl(`dummy.${tab.overrideLanguage}`)
        : fileIconUrl(tab.title);
    return url ? (
      <img
        src={url}
        alt=""
        className="size-3.5 shrink-0 object-contain"
        onError={(e) => {
          const img = e.currentTarget;
          if (img.dataset.fallback) return;
          img.dataset.fallback = "1";
          img.src = fileIconUrl("dummy.txt");
        }}
      />
    ) : null;
  }
  if (tab.kind === "preview") {
    return (
      <HugeiconsIcon
        icon={Globe02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "ai-diff") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "terminal" && tab.private) {
    return (
      <HugeiconsIcon
        icon={IncognitoIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "terminal" && tab.tmux) {
    return (
      <span className="shrink-0 rounded border border-primary/30 px-1 text-[8px] font-semibold leading-3 text-primary">
        tmux
      </span>
    );
  }
  if (tab.kind === "git-diff" || tab.kind === "git-commit-file") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-history") {
    return (
      <HugeiconsIcon
        icon={Clock01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "fleet") {
    return (
      <HugeiconsIcon
        icon={HierarchySquare01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={ComputerTerminal02Icon}
      size={14}
      strokeWidth={2}
      className="shrink-0"
    />
  );
}

function TabRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Guards against a trailing blur re-resolving an edit that Enter/Escape
  // already finished (Escape must never commit).
  const done = useRef(false);
  const mountedAt = useRef(performance.now());

  useEffect(() => {
    // Focus on the next frame so it runs after the context menu restores focus
    // to its trigger when closing; a synchronous focus would be stolen.
    const raf = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };

  // explicit = the user pressed Enter, which pins even the unchanged label. A
  // plain blur with no change must not freeze the cwd-derived default into a
  // custom title.
  const commit = (value: string, explicit: boolean) => {
    if (!explicit && value.trim() === initial.trim()) finish(onCancel);
    else finish(() => onCommit(value));
  };

  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label="Rename tab"
      className={cn(
        "w-28 min-w-0 rounded-sm bg-background px-1 text-xs text-foreground",
        "outline-none ring-1 ring-border focus:ring-ring",
      )}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(e.currentTarget.value, true);
        else if (e.key === "Escape") finish(onCancel);
      }}
      onBlur={(e) => {
        // Switching windows/apps blurs the input; keep the edit open instead
        // of resolving it on the way out.
        if (!document.hasFocus()) return;
        // A blur right after opening is focus being restored elsewhere (menu
        // close, terminal re-show), not the user leaving: take focus back.
        if (performance.now() - mountedAt.current < 300) {
          const input = e.currentTarget;
          requestAnimationFrame(() => input.focus());
          return;
        }
        commit(e.currentTarget.value, false);
      }}
    />
  );
}
