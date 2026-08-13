import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  allServers,
  detectBinary,
  type LspPreset,
  redetectBinary,
  resolveServerBinary,
  useLspRuntimeStore,
} from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type LspCustomServer,
  setLspActivation,
  setLspCustomServers,
  setLspVenvOverride,
} from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Delete02Icon,
  FolderOpenIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useState } from "react";
import { SettingRow } from "./SettingRow";

export function LspServersGroup() {
  const activation = usePreferencesStore((s) => s.lspActivation);
  const customServers = usePreferencesStore((s) => s.lspCustomServers);
  const servers = allServers(customServers);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Language servers</Label>
        <AddCustomServerDialog customServers={customServers} />
      </div>
      {servers.map((server) => (
        <ServerRow
          key={server.id}
          server={server}
          enabled={activation[server.id] === "enabled"}
          custom={customServers.some((c) => c.id === server.id)}
          customServers={customServers}
        />
      ))}
      <PythonVenvOverride servers={servers} />
    </div>
  );
}

/** The main window mirrors its project root here so this window can scope the
 * override to the repo in view. */
function useActiveRoot(): string | null {
  const [root, setRoot] = useState<string | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void invoke<string | null>("get_active_root").then((r) =>
      setRoot(r ?? null),
    );
    void listen<string | null>("terax:active-root", (e) =>
      setRoot(e.payload ?? null),
    ).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);
  return root;
}

/** Collapse a path to its last three segments, expandable on click. Keeps the
 * override row from overflowing with deep home-directory venv paths. */
function TruncatedPath({ path }: { path: string }) {
  const [expanded, setExpanded] = useState(false);
  const segs = path.split(/[\\/]+/).filter(Boolean);
  const short =
    !expanded && segs.length > 3 ? `…/${segs.slice(-3).join("/")}` : path;
  return (
    <button
      type="button"
      onClick={() => setExpanded((e) => !e)}
      title={expanded ? "Collapse" : path}
      className="cursor-pointer break-all text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
    >
      {short}
    </button>
  );
}

/** Per-repo venv the Python language servers (pyright, ruff, …) resolve their
 * binaries from. Auto-detects `.venv`/`venv` under the repo; this overrides it
 * for non-standard layouts. */
function PythonVenvOverride({ servers }: { servers: LspPreset[] }) {
  const root = useActiveRoot();
  const overrides = usePreferencesStore((s) => s.lspVenvOverrides);
  const activation = usePreferencesStore((s) => s.lspActivation);
  const venv = root ? (overrides[root] ?? null) : null;
  const [resolved, setResolved] = useState<Record<string, string | null>>({});

  // Only Python servers live in a venv; a venv override is meaningless for
  // rust-analyzer or gopls.
  const pyServers = servers.filter(
    (s) => "py" in s.languages && activation[s.id] === "enabled",
  );
  const pyKey = pyServers.map((s) => s.command).join(",");

  useEffect(() => {
    if (!root || pyServers.length === 0) {
      setResolved({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      pyServers.map(
        async (s) =>
          [s.id, await resolveServerBinary(s.command, root, venv)] as const,
      ),
    ).then((entries) => {
      if (!cancelled) setResolved(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
    // pyKey stands in for the server list; resolution keys on command+root+venv.
    // biome-ignore lint/correctness/useExhaustiveDependencies: pyKey covers pyServers
  }, [root, venv, pyKey]);

  const pick = async () => {
    if (!root) return;
    const dir = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: venv ?? root,
      title: "Select Python venv directory",
    });
    if (typeof dir === "string") await setLspVenvOverride(root, dir);
  };

  if (pyServers.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-1.5 border-border/60 border-t pt-3">
      <div className="flex items-center justify-between">
        <Label>Python venv</Label>
        <div className="flex items-center gap-1.5">
          {venv ? (
            <button
              type="button"
              className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
              onClick={() => root && void setLspVenvOverride(root, null)}
              title="Clear override (use auto-detect)"
            >
              <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
            </button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={!root}
            onClick={() => void pick()}
          >
            <HugeiconsIcon
              icon={FolderOpenIcon}
              size={12}
              strokeWidth={1.75}
              className="mr-1"
            />
            {venv ? "Change" : "Set venv"}
          </Button>
        </div>
      </div>

      {!root ? (
        <p className="text-[11px] text-muted-foreground">
          Open a project folder to set its venv.
        </p>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">
            {venv ? (
              <span className="flex items-center gap-1">
                Override: <TruncatedPath path={venv} />
              </span>
            ) : (
              "Auto-detecting .venv / venv in the project root."
            )}
          </p>
          <div className="flex flex-col gap-1">
            {pyServers.map((s) => {
              const bin = resolved[s.id];
              return (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-2 text-[11px]"
                >
                  <span className="text-foreground">{s.name}</span>
                  {bin === undefined ? (
                    <span className="text-muted-foreground">checking…</span>
                  ) : bin ? (
                    <TruncatedPath path={bin} />
                  ) : (
                    <span className="text-amber-500">not found</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function ServerRow({
  server,
  enabled,
  custom,
  customServers,
}: {
  server: LspPreset;
  enabled: boolean;
  custom: boolean;
  customServers: LspCustomServer[];
}) {
  const detected = useLspRuntimeStore((s) => s.detected[server.command]);

  useEffect(() => {
    void detectBinary(server.command);
  }, [server.command]);

  const langs = Object.keys(server.languages).join(", ");
  const status =
    detected === undefined
      ? "checking..."
      : detected
        ? detected
        : "not found on PATH";

  return (
    <SettingRow
      title={
        <span className="flex items-center gap-1.5">
          {server.name}
          {detected ? (
            <span className="size-1.5 rounded-full bg-emerald-500" />
          ) : null}
        </span>
      }
      description={`${server.command} (${langs}) - ${status}`}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => void redetectBinary(server.command)}
          title="Detect again"
        >
          <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} />
        </button>
        {custom ? (
          <button
            type="button"
            className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
            onClick={() => {
              void setLspActivation(server.id, null);
              void setLspCustomServers(
                customServers.filter((c) => c.id !== server.id),
              );
            }}
            title="Remove server"
          >
            <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
          </button>
        ) : null}
        <Switch
          checked={enabled}
          onCheckedChange={(v) =>
            void setLspActivation(server.id, v ? "enabled" : "dismissed")
          }
        />
      </div>
    </SettingRow>
  );
}

function AddCustomServerDialog({
  customServers,
}: {
  customServers: LspCustomServer[];
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [extensions, setExtensions] = useState("");
  const [languageId, setLanguageId] = useState("");
  const [rootMarkers, setRootMarkers] = useState("");
  const formId = useId();

  const parsedExts = extensions
    .split(",")
    .map((s) => s.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  const valid =
    name.trim().length > 0 &&
    command.trim().length > 0 &&
    parsedExts.length > 0;

  const save = () => {
    if (!valid) return;
    const langId = languageId.trim() || (parsedExts[0] ?? "");
    const id = `custom-${command.trim()}`;
    const server: LspCustomServer = {
      id,
      name: name.trim(),
      command: command.trim(),
      args: args.trim() ? args.trim().split(/\s+/) : [],
      languages: Object.fromEntries(parsedExts.map((e) => [e, langId])),
      rootMarkers: rootMarkers
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    void setLspCustomServers([
      ...customServers.filter((c) => c.id !== id),
      server,
    ]);
    void setLspActivation(id, "enabled");
    setOpen(false);
    setName("");
    setCommand("");
    setArgs("");
    setExtensions("");
    setLanguageId("");
    setRootMarkers("");
  };

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
  ) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`${formId}-${label}`} className="text-[11px]">
        {label}
      </Label>
      <Input
        id={`${formId}-${label}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 text-xs"
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]">
          Add custom server
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Custom language server</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2.5">
          {field("Name", name, setName, "Zig")}
          {field("Command", command, setCommand, "zls")}
          {field("Arguments", args, setArgs, "--stdio")}
          {field("File extensions", extensions, setExtensions, "zig, zon")}
          {field("LSP language id", languageId, setLanguageId, "zig")}
          {field("Root markers", rootMarkers, setRootMarkers, "build.zig")}
        </div>
        <DialogFooter>
          <Button size="sm" disabled={!valid} onClick={save}>
            Add server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
