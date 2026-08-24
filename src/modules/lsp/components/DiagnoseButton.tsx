import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FORMATTER_LABELS } from "@/modules/editor/lib/externalFormat";
import {
  allServers,
  clearResolvedBinaries,
  resolveServerBinary,
  useLspRuntimeStore,
} from "@/modules/lsp";
import { LSP_PRESETS } from "@/modules/lsp/lib/presets";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setLspVenvOverride as setVenv } from "@/modules/settings/store";
import { useWorkspaceEnvStore, currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Alert02Icon,
  FolderOpenIcon,
  Refresh01Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

function useActiveRoot(): string | null {
  const [root, setRoot] = useState<string | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void invoke<string | null>("get_active_root").then((r) => setRoot(r ?? null));
    void listen<string | null>("terax:active-root", (e) => setRoot(e.payload ?? null)).then(
      (u) => {
        unlisten = u;
      },
    );
    return () => unlisten?.();
  }, []);
  return root;
}

import { useRecentCwdStore } from "@/modules/terminal/lib/recentCwdStore";

function useSuggestedRoot(activeRoot: string | null): string[] {
  const recentCwds = useRecentCwdStore((s) => s.recentCwds);
  return useMemo(() => {
    const out: string[] = [];
    for (const c of recentCwds) {
      if (c && c !== activeRoot && !out.includes(c)) out.push(c);
    }
    return out.slice(0, 3);
  }, [recentCwds, activeRoot]);
}

type MarkerHit = { name: string; exists: boolean };

const MARKER_TEMPLATES: Record<string, string> = {
  "pyproject.toml": '[project]\nname = "my-project"\nversion = "0.0.0"\n',
  "setup.py": "from setuptools import setup\nsetup()\n",
  "requirements.txt": "# requirements\n",
  Pipfile: '[[source]]\nname = "pypi"\nurl = "https://pypi.org/simple"\n',
  "tsconfig.json": '{\n  "compilerOptions": {}\n}\n',
  "jsconfig.json": '{\n  "compilerOptions": {}\n}\n',
  "package.json": '{\n  "name": "my-project", "version": "0.0.0" }\n',
  "Cargo.toml": '[package]\nname = "my-project"\nversion = "0.1.0"\nedition = "2021"\n',
  "go.mod": "module my-project\n\ngo 1.22\n",
  "go.work": "go 1.22\n",
  ".git": "",
};

const LANGUAGE_OPTIONS = [
  { id: "py", label: "Python", preset: "pyright" },
  { id: "ts", label: "TypeScript", preset: "typescript" },
  { id: "rs", label: "Rust", preset: "rust-analyzer" },
  { id: "go", label: "Go", preset: "gopls" },
] as const;

function detectLanguageFromPath(path: string | null): string | null {
  if (!path) return null;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["py"].includes(ext)) return "py";
  if (["ts", "tsx", "js", "jsx"].includes(ext)) return "ts";
  if (ext === "rs") return "rs";
  if (ext === "go") return "go";
  return null;
}

export function LspDiagnoseButton() {
  const [open, setOpen] = useState(false);
  const activeRoot = useActiveRoot();
  const suggestedExtra = useSuggestedRoot(activeRoot);
  const [manualRoot, setManualRoot] = useState<string | null>(null);
  const root = manualRoot ?? activeRoot;
  const env = useWorkspaceEnvStore((s) => s.env);
  const isSsh = env.kind === "ssh";
  const sshHost = isSsh ? env.host : null;

  const overrides = usePreferencesStore((s) => s.lspVenvOverrides);
  const activation = usePreferencesStore((s) => s.lspActivation);
  const customServers = usePreferencesStore((s) => s.lspCustomServers);
  const servers = useMemo(() => allServers(customServers), [customServers]);
  const venv = root ? (overrides[root] ?? "") : "";
  const [venvDraft, setVenvDraft] = useState(venv);
  useEffect(() => setVenvDraft(venv), [venv]);
  const [venvSuggestion, setVenvSuggestion] = useState<string | null>(null);
  const [checkingVenv, setCheckingVenv] = useState(false);

  const editorFormatter = usePreferencesStore((s) => s.editorFormatter);
  const editorFormatterByLang = usePreferencesStore((s) => s.editorFormatterByLang);

  const [selectedLang, setSelectedLang] = useState<string>("auto");
  const autoLang = useMemo(() => detectLanguageFromPath(activeRoot), [activeRoot]);
  const effectiveLang = selectedLang === "auto" ? (autoLang ?? "py") : selectedLang;

  const [markerHits, setMarkerHits] = useState<MarkerHit[] | null>(null);
  const [checkingMarkers, setCheckingMarkers] = useState(false);
  const [resolved, setResolved] = useState<Record<string, string | null>>({});
  const [reloading, setReloading] = useState(false);

  // Language-filtered markers
  const relevantMarkers = useMemo(() => {
    const preset = LSP_PRESETS.find((p) => effectiveLang in p.languages);
    if (preset) return preset.rootMarkers;
    // For "auto" with no match, show all
    const set = new Set<string>();
    for (const s of LSP_PRESETS) for (const m of s.rootMarkers) set.add(m);
    for (const s of servers) for (const m of s.rootMarkers) set.add(m);
    return [...set].sort();
  }, [effectiveLang, servers]);

  const allMarkersForCheck = useMemo(() => {
    const set = new Set<string>();
    for (const s of LSP_PRESETS) for (const m of s.rootMarkers) set.add(m);
    for (const s of servers) for (const m of s.rootMarkers) set.add(m);
    return [...set].sort();
  }, [servers]);

  // Check which markers exist in current root
  useEffect(() => {
    if (!root || !open) {
      setMarkerHits(null);
      return;
    }
    let cancelled = false;
    setCheckingMarkers(true);
    const ws = currentWorkspaceEnv();
    void Promise.all(
      allMarkersForCheck.map(async (m) => {
        const p = root.endsWith("/") || root.endsWith("\\") ? `${root}${m}` : `${root}/${m}`;
        try {
          await invoke("fs_stat", { path: p, workspace: ws });
          return { name: m, exists: true } as MarkerHit;
        } catch {
          return { name: m, exists: false } as MarkerHit;
        }
      }),
    ).then((hits) => {
      if (!cancelled) {
        setMarkerHits(hits);
        setCheckingMarkers(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [root, open, allMarkersForCheck]);

  // Auto-detect .venv / venv
  useEffect(() => {
    if (!root || !open) {
      setVenvSuggestion(null);
      return;
    }
    // Don't suggest if there's already an override
    if (venv) {
      setVenvSuggestion(null);
      return;
    }
    let cancelled = false;
    setCheckingVenv(true);
    const ws = currentWorkspaceEnv();
    const candidates = [".venv", "venv"];
    void (async () => {
      for (const dir of candidates) {
        const base = root.endsWith("/") || root.endsWith("\\") ? `${root}${dir}` : `${root}/${dir}`;
        // Check bin/python or Scripts/python.exe
        const bins = [`${base}/bin/python`, `${base}/bin/python3`, `${base}/Scripts/python.exe`];
        for (const b of bins) {
          try {
            await invoke("fs_stat", { path: b, workspace: ws });
            if (!cancelled) {
              setVenvSuggestion(base);
              setCheckingVenv(false);
            }
            return;
          } catch {}
        }
        // Also accept the venv dir itself if bin check fails but dir exists
        try {
          await invoke("fs_stat", { path: base, workspace: ws });
          if (!cancelled) {
            setVenvSuggestion(base);
            setCheckingVenv(false);
          }
          return;
        } catch {}
      }
      if (!cancelled) {
        setVenvSuggestion(null);
        setCheckingVenv(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, open, venv]);

  // Resolve Python servers against this root+venv
  useEffect(() => {
    if (!root || !open) {
      setResolved({});
      return;
    }
    const ws = currentWorkspaceEnv();
    const pyServers = servers.filter((s) => "py" in s.languages);
    if (pyServers.length === 0) {
      setResolved({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      pyServers.map(
        async (s) =>
          [s.id, await resolveServerBinary(s.command, root, venv || null, ws)] as const,
      ),
    ).then((entries) => {
      if (!cancelled) setResolved(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [root, venv, open, servers]);

  const hasAnyMarker = markerHits?.some((h) => h.exists) ?? false;
  const missingRelevant = useMemo(() => {
    if (!markerHits) return [];
    const set = new Set(relevantMarkers);
    return markerHits.filter((h) => !h.exists && set.has(h.name));
  }, [markerHits, relevantMarkers]);
  const missingAll = markerHits?.filter((h) => !h.exists) ?? [];
  const showPySection = effectiveLang === "py";

  const createMarker = async (name: string) => {
    if (!root) return;
    const ws = currentWorkspaceEnv();
    const path = root.endsWith("/") || root.endsWith("\\") ? `${root}${name}` : `${root}/${name}`;
    const content = MARKER_TEMPLATES[name] ?? "";
    try {
      if (name === ".git") {
        await invoke("fs_create_dir", { path, workspace: ws });
      } else {
        await invoke("fs_write_file", { path, content, workspace: ws });
      }
      toast.success(`Created ${name} in ${root}`);
      setMarkerHits((prev) =>
        prev ? prev.map((h) => (h.name === name ? { ...h, exists: true } : h)) : prev,
      );
    } catch (e) {
      toast.error(`Failed to create ${name}`, { description: String(e) });
    }
  };

  const pickRoot = async () => {
    const dir = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: root ?? undefined,
      title: "Select project root",
    });
    if (typeof dir === "string") setManualRoot(dir);
  };

  const pickVenv = async () => {
    if (!root) return;
    const dir = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: venvDraft || venvSuggestion || root,
      title: isSsh ? `Select venv on ${sshHost}` : "Select Python venv directory",
    });
    if (typeof dir === "string") setVenvDraft(dir);
  };

  const saveVenv = async () => {
    if (!root) return;
    await setVenv(root, venvDraft || null);
    toast.success(venvDraft ? `Venv set for ${root}` : `Venv cleared — auto-detect`);
  };

  const clearVenv = async () => {
    if (!root) return;
    setVenvDraft("");
    await setVenv(root, null);
    toast.success("Venv override cleared");
  };

  const applySuggestion = () => {
    if (venvSuggestion) setVenvDraft(venvSuggestion);
  };

  const reload = async () => {
    if (!root) return;
    setReloading(true);
    try {
      clearResolvedBinaries(root);
      const ws = currentWorkspaceEnv();
      const pyServers = servers.filter((s) => "py" in s.languages);
      for (const s of pyServers) {
        await resolveServerBinary(s.command, root, venvDraft || null, ws);
        useLspRuntimeStore.getState().bumpGeneration(s.id);
      }
      for (const s of servers) {
        if (activation[s.id] === "enabled") {
          useLspRuntimeStore.getState().bumpGeneration(s.id);
        }
      }
      toast.success("Reloaded for " + root);
    } finally {
      setReloading(false);
    }
  };

  const rootLabel = root ?? "— no active root";
  const workspaceLabel = isSsh ? `ssh:${sshHost}` : env.kind === "wsl" ? `wsl:${env.distro}` : "local";

  // Popover should stay open when clicking the explorer/sidebar (so paths can be copied),
  // but close when clicking the editor or terminal. We prevent the default outside-
  // interact when the target isn't editor/terminal.
  const handleInteractOutside = (e: CustomEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const isEditorOrTerminal =
      !!target.closest(".cm-editor") ||
      !!target.closest(".xterm") ||
      !!target.closest("[data-terminal-pane]") ||
      !!target.closest("[data-editor-pane]");
    // If click is NOT in editor/terminal, keep the popover open (allow copying from explorer)
    if (!isEditorOrTerminal) {
      e.preventDefault();
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Diagnose LSP / Formatter"
        >
          <HugeiconsIcon icon={Wrench01Icon} size={15} strokeWidth={1.75} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={10}
        className="w-[420px] max-h-[82vh] overflow-y-auto p-0 gap-0"
        onInteractOutside={handleInteractOutside as any}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <h4 className="flex items-center gap-2 text-sm font-medium">
              <HugeiconsIcon icon={Wrench01Icon} size={14} strokeWidth={1.75} />
              Diagnose — LSP & Formatter
            </h4>
            <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
              {workspaceLabel}
            </span>
          </div>
          {isSsh && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              Remote — venv & markers are on {sshHost}
            </p>
          )}

          {/* Language */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px]">Language</Label>
            <Select value={selectedLang} onValueChange={setSelectedLang}>
              <SelectTrigger className="h-7 text-xs">
                <SelectValue placeholder="Auto" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto{autoLang ? ` (${LANGUAGE_OPTIONS.find((o) => o.id === autoLang)?.label ?? autoLang})` : ""}</SelectItem>
                {LANGUAGE_OPTIONS.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              Filters which root markers and venv are suggested. Auto tries the current file&apos;s extension.
            </p>
          </div>

          {/* Root */}
          <div className="flex flex-col gap-2 border-t pt-3">
            <Label className="text-[11px]">Project root</Label>
            <div className="flex gap-2">
              <Input
                value={manualRoot ?? activeRoot ?? ""}
                onChange={(e) => setManualRoot(e.target.value || null)}
                placeholder={activeRoot ? activeRoot : "No active project — pick a root"}
                className="h-7 flex-1 font-mono text-xs"
              />
              <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => void pickRoot()}>
                <HugeiconsIcon icon={FolderOpenIcon} size={12} strokeWidth={1.75} className="mr-1" />
                Browse
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Current: <span className="font-mono break-all select-all">{rootLabel}</span>
              {manualRoot && activeRoot && manualRoot !== activeRoot && (
                <button
                  type="button"
                  onClick={() => setManualRoot(null)}
                  className="ml-2 underline hover:text-foreground"
                >
                  use active
                </button>
              )}
            </p>
            {suggestedExtra.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {suggestedExtra.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setManualRoot(s)}
                    className="rounded bg-accent px-2 py-0.5 font-mono text-[11px] hover:bg-accent/80"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Root markers */}
          <div className="flex flex-col gap-1.5 border-t pt-3">
            <Label className="text-[11px]">
              Root markers{" "}
              <span className="font-normal text-muted-foreground">
                for {LANGUAGE_OPTIONS.find((o) => o.id === effectiveLang)?.label ?? effectiveLang}
              </span>
            </Label>
            {!root ? (
              <p className="text-[11px] text-muted-foreground">Pick a root to check markers.</p>
            ) : checkingMarkers ? (
              <p className="text-[11px] text-muted-foreground">Checking…</p>
            ) : hasAnyMarker ? (
              <div className="flex flex-wrap gap-1.5">
                {markerHits!.map((h) => {
                  const relevant = relevantMarkers.includes(h.name);
                  return (
                    <span
                      key={h.name}
                      className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${h.exists ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : relevant ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground"} ${!relevant ? "opacity-60" : ""}`}
                    >
                      {h.exists ? "● " : "○ "}
                      {h.name}
                    </span>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                  <HugeiconsIcon icon={Alert02Icon} size={12} strokeWidth={1.75} />
                  No LSP root marker found
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  The server won&apos;t start without one. Create one of:
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {missingRelevant.slice(0, 8).map((h) => (
                    <Button
                      key={h.name}
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => void createMarker(h.name)}
                    >
                      + {h.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {hasAnyMarker && missingRelevant.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {missingRelevant.map((h) => (
                  <Button
                    key={h.name}
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => void createMarker(h.name)}
                  >
                    + {h.name}
                  </Button>
                ))}
              </div>
            )}
            {hasAnyMarker && missingAll.length > 0 && (
              <details className="text-[11px]">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Show all markers
                </summary>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {missingAll.map((h) => (
                    <Button
                      key={h.name}
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => void createMarker(h.name)}
                    >
                      + {h.name}
                    </Button>
                  ))}
                </div>
              </details>
            )}
          </div>

          {/* Venv — only for Python */}
          {showPySection ? (
            <div className="flex flex-col gap-2 border-t pt-3">
              <div className="flex items-center justify-between">
                <Label className="text-[11px]">Python venv {isSsh ? `(on ${sshHost})` : ""}</Label>
                <span className="text-[10px] text-muted-foreground">for {root ? root.split(/[\\/]/).pop() : "—"}</span>
              </div>
              {venvSuggestion && !venv && (
                <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-2 py-1.5 text-[11px]">
                  <span className="text-emerald-700 dark:text-emerald-400">
                    Found: <span className="font-mono">{venvSuggestion}</span>
                  </span>
                  <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-[11px]" onClick={applySuggestion}>
                    Use
                  </Button>
                </div>
              )}
              {checkingVenv && <p className="text-[11px] text-muted-foreground">Probing .venv / venv…</p>}
              <div className="flex gap-2">
                <Input
                  value={venvDraft}
                  onChange={(e) => setVenvDraft(e.target.value)}
                  placeholder={isSsh ? "/home/user/.venv  (remote)" : ".venv  or  /abs/path/to/venv"}
                  className="h-7 flex-1 font-mono text-xs"
                  disabled={!root}
                />
                <Button variant="outline" size="sm" className="h-7 px-2" disabled={!root} onClick={() => void pickVenv()}>
                  <HugeiconsIcon icon={FolderOpenIcon} size={12} strokeWidth={1.75} className="mr-1" />
                  {isSsh ? "Browse" : "Browse"}
                </Button>
              </div>
              <div className="flex gap-2">
                <Button variant="default" size="sm" className="h-7 px-3 text-[11px]" disabled={!root} onClick={() => void saveVenv()}>
                  Save venv
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={!root || !venv} onClick={() => void clearVenv()}>
                  Clear
                </Button>
              </div>
              {!root ? (
                <p className="text-[11px] text-muted-foreground">Pick a root first.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {servers
                    .filter((s) => "py" in s.languages)
                    .map((s) => {
                      const bin = resolved[s.id];
                      return (
                        <div key={s.id} className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="text-foreground">{s.name}</span>
                          {bin === undefined ? (
                            <span className="text-muted-foreground">checking…</span>
                          ) : bin ? (
                            <span className="max-w-48 truncate font-mono text-muted-foreground select-all" title={bin}>
                              {bin}
                            </span>
                          ) : (
                            <span className="text-amber-500">not found{isSsh ? " on remote" : ""}</span>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          ) : (
            <p className="border-t pt-3 text-[11px] text-muted-foreground">Venv is only for Python. Switch language to Python to configure it.</p>
          )}

          {/* Formatter */}
          <div className="flex flex-col gap-1.5 border-t pt-3">
            <Label className="text-[11px]">Formatter</Label>
            <p className="text-[11px] text-muted-foreground">
              Global: <span className="font-medium text-foreground">{FORMATTER_LABELS[editorFormatter]}</span>
              {Object.keys(editorFormatterByLang).length > 0 && (
                <span>
                  {" "}
                  · overrides:{" "}
                  {Object.entries(editorFormatterByLang)
                    .map(([lang, f]) => `${lang}→${FORMATTER_LABELS[f]}`)
                    .join(", ")}
                </span>
              )}
            </p>
            <p className="text-[10px] text-muted-foreground">
              Runs on the {isSsh ? "remote" : "local"} machine. Change in Settings → Editor.
            </p>
          </div>

          {/* Actions */}
          <div className="flex gap-2 border-t pt-3">
            <Button variant="outline" size="sm" className="h-7 px-3 text-[11px]" disabled={!root || reloading} onClick={() => void reload()}>
              <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} className="mr-1" />
              {reloading ? "Reloading…" : "Reload for current"}
            </Button>
            <span className="self-center text-[10px] text-muted-foreground">Re-probes {isSsh ? "remote" : "local"} binaries</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
