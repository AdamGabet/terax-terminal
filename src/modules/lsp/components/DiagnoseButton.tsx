import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { currentWorkspaceEnv } from "@/modules/workspace";
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

export function LspDiagnoseButton() {
  const [open, setOpen] = useState(false);
  const activeRoot = useActiveRoot();
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

  const editorFormatter = usePreferencesStore((s) => s.editorFormatter);
  const editorFormatterByLang = usePreferencesStore((s) => s.editorFormatterByLang);

  const [markerHits, setMarkerHits] = useState<MarkerHit[] | null>(null);
  const [checkingMarkers, setCheckingMarkers] = useState(false);
  const [resolved, setResolved] = useState<Record<string, string | null>>({});
  const [reloading, setReloading] = useState(false);

  // Gather all unique markers across presets
  const allMarkers = useMemo(() => {
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
      allMarkers.map(async (m) => {
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
  }, [root, open, allMarkers]);

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
  const missingMarkers = markerHits?.filter((h) => !h.exists) ?? [];

  const createMarker = async (name: string) => {
    if (!root) return;
    const ws = currentWorkspaceEnv();
    const path = root.endsWith("/") || root.endsWith("\\") ? `${root}${name}` : `${root}/${name}`;
    const content = MARKER_TEMPLATES[name] ?? "";
    // .git is a directory marker on disk; use fs_create_dir for it
    try {
      if (name === ".git") {
        await invoke("fs_create_dir", { path, workspace: ws });
      } else {
        await invoke("fs_write_file", { path, content, workspace: ws });
      }
      toast.success(`Created ${name} in ${root}`);
      // re-check
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
      defaultPath: venvDraft || root,
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

  const reload = async () => {
    if (!root) return;
    setReloading(true);
    try {
      clearResolvedBinaries(root);
      // Force re-resolve for py servers and bump LSP generations so open docs re-acquire
      const ws = currentWorkspaceEnv();
      const pyServers = servers.filter((s) => "py" in s.languages);
      for (const s of pyServers) {
        await resolveServerBinary(s.command, root, venvDraft || null, ws);
        useLspRuntimeStore.getState().bumpGeneration(s.id);
      }
      // Also bump all active presets touching this root so formatter/lsp restarts
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Diagnose LSP / Formatter"
        >
          <HugeiconsIcon icon={Wrench01Icon} size={15} strokeWidth={1.75} />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={Wrench01Icon} size={16} strokeWidth={1.75} />
            Diagnose — LSP & Formatter
          </DialogTitle>
          <DialogDescription>
            Workspace: <span className="font-mono text-xs">{workspaceLabel}</span>
            {isSsh && <span className="text-amber-600 dark:text-amber-400"> · remote venv & markers are on {sshHost}</span>}
          </DialogDescription>
        </DialogHeader>

        {/* Root */}
        <div className="flex flex-col gap-2">
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
            Current: <span className="font-mono break-all">{rootLabel}</span>
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
        </div>

        {/* Root markers */}
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <Label className="text-[11px]">Root markers</Label>
          {!root ? (
            <p className="text-[11px] text-muted-foreground">Pick a root to check markers.</p>
          ) : checkingMarkers ? (
            <p className="text-[11px] text-muted-foreground">Checking {allMarkers.length} markers…</p>
          ) : hasAnyMarker ? (
            <div className="flex flex-wrap gap-1.5">
              {markerHits!.map((h) => (
                <span
                  key={h.name}
                  className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${h.exists ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}
                >
                  {h.exists ? "● " : "○ "}
                  {h.name}
                </span>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                <HugeiconsIcon icon={Alert02Icon} size={12} strokeWidth={1.75} />
                No LSP root marker found in this folder
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                The language server won&apos;t start without one. Create one of:
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {missingMarkers.slice(0, 12).map((h) => (
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
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                {isSsh ? `Creates on ${sshHost} via SSH.` : "Creates in the project root."} For Python, pyproject.toml is recommended.
              </p>
            </div>
          )}
          {hasAnyMarker && markerHits && (
            <details className="text-[11px]">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Create another marker
              </summary>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {missingMarkers.map((h) => (
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

        {/* Venv */}
        <div className="flex flex-col gap-2 border-t pt-3">
          <div className="flex items-center justify-between">
            <Label className="text-[11px]">Python venv {isSsh ? `(on ${sshHost})` : ""}</Label>
            <span className="text-[10px] text-muted-foreground">for {root ? root.split(/[\\/]/).pop() : "—"}</span>
          </div>
          <div className="flex gap-2">
            <Input
              value={venvDraft}
              onChange={(e) => setVenvDraft(e.target.value)}
              placeholder={isSsh ? "/home/user/.venv  (remote path)" : ".venv  or  /abs/path/to/venv"}
              className="h-7 flex-1 font-mono text-xs"
              disabled={!root}
            />
            <Button variant="outline" size="sm" className="h-7 px-2" disabled={!root} onClick={() => void pickVenv()}>
              <HugeiconsIcon icon={FolderOpenIcon} size={12} strokeWidth={1.75} className="mr-1" />
              {isSsh ? "Browse remote" : "Browse"}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="default" size="sm" className="h-7 px-3 text-[11px]" disabled={!root} onClick={() => void saveVenv()}>
              Save venv
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={!root || !venv} onClick={() => void clearVenv()}>
              Clear (auto-detect .venv/venv)
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
                        <span className="max-w-48 truncate font-mono text-muted-foreground" title={bin}>
                          {bin}
                        </span>
                      ) : (
                        <span className="text-amber-500">not found{isSsh ? " on remote" : " on PATH/venv"}</span>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>

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
            Change in Settings → Editor. Formatter runs on the {isSsh ? "remote host" : "local machine"} for this workspace.
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-2 border-t pt-3">
          <Button variant="outline" size="sm" className="h-7 px-3 text-[11px]" disabled={!root || reloading} onClick={() => void reload()}>
            <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} className="mr-1" />
            {reloading ? "Reloading…" : "Reload for current"}
          </Button>
          <span className="self-center text-[10px] text-muted-foreground">
            Restarts LSP for this root, re-probes {isSsh ? "remote" : "local"} binaries
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
