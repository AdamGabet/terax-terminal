import { resolveLanguage } from "@/modules/editor/lib/languageResolver";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { useEffect, useState } from "react";
import { resolveServerBinary } from "./detect";
import { type LspPreset, serverForLanguage } from "./presets";
import { resolveWorkspaceRoot } from "./root";
import { type LspSessionStatus, useLspRuntimeStore } from "./runtimeStore";

export type LspHint =
  | { kind: "enable"; preset: LspPreset }
  | { kind: "install"; preset: LspPreset }
  | { kind: "active"; preset: LspPreset; status: LspSessionStatus }
  | { kind: "error"; preset: LspPreset; reason: string };

export function useLspHint(filePath: string | null): LspHint | null {
  const [langId, setLangId] = useState<string | null>(null);
  const env = useWorkspaceEnvStore((s) => s.env);
  // LSP runs on local and SSH workspaces; WSL isn't wired up yet.
  const supported = env.kind === "local" || env.kind === "ssh";

  useEffect(() => {
    if (!filePath) {
      setLangId(null);
      return;
    }
    let cancelled = false;
    void resolveLanguage(filePath).then((result) => {
      if (cancelled) return;
      const ext = filePath.split(".").pop()?.toLowerCase() ?? null;
      setLangId(result?.id || ext);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const customServers = usePreferencesStore((s) => s.lspCustomServers);
  const preset = serverForLanguage(langId, customServers);
  const activation = usePreferencesStore((s) =>
    preset ? s.lspActivation[preset.id] : undefined,
  );
  const venvOverrides = usePreferencesStore((s) => s.lspVenvOverrides);
  const session = useLspRuntimeStore((s) =>
    preset
      ? Object.values(s.sessions).find((x) => x.presetId === preset.id)
      : undefined,
  );
  const failure = useLspRuntimeStore((s) =>
    preset ? s.failed[preset.id] : undefined,
  );

  // Resolve the binary the way the session would (repo venv → override → PATH)
  // so the enable/install hint reflects a venv-only install instead of nagging
  // "not on PATH". undefined = still checking. Only needed before the user has
  // enabled or dismissed the server.
  const [detected, setDetected] = useState<string | null | undefined>(
    undefined,
  );
  const command = preset?.command;
  const markersKey = preset?.rootMarkers.join(",");
  useEffect(() => {
    if (!command || !supported || activation !== undefined) {
      setDetected(undefined);
      return;
    }
    let cancelled = false;
    setDetected(undefined);
    void (async () => {
      const markers =
        markersKey && markersKey.length > 0 ? markersKey.split(",") : [".git"];
      const root = filePath
        ? await resolveWorkspaceRoot(filePath, markers, env)
        : null;
      const venv = root ? (venvOverrides[root] ?? null) : null;
      const bin = await resolveServerBinary(command, root, venv, env);
      if (!cancelled) setDetected(bin);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    command,
    markersKey,
    supported,
    env,
    activation,
    filePath,
    venvOverrides,
  ]);

  if (!preset || !supported) return null;
  if (activation === "dismissed") return null;
  if (activation === "enabled") {
    if (session) return { kind: "active", preset, status: session.status };
    if (failure) return { kind: "error", preset, reason: failure };
    return null;
  }
  if (detected === undefined) return null;
  return detected ? { kind: "enable", preset } : { kind: "install", preset };
}
