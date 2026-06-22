import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { setLastWslDistro } from "@/modules/settings/store";

export type WorkspaceEnv =
  | { kind: "local" }
  | { kind: "wsl"; distro: string }
  | { kind: "ssh"; host: string };

export type WslDistro = {
  name: string;
  default: boolean;
  running: boolean;
};

export type SshHostEntry = {
  host: string;
  connected: boolean;
};

export type SshConnectInfo = {
  host: string;
  home: string;
  shell: string;
};

/**
 * Liveness of the window's SSH link. Only meaningful when `env.kind === "ssh"`.
 * "disconnected" is set when an SSH terminal's `ssh -t` exits unexpectedly
 * (VPN/network drop); "reconnecting" while the manual Reconnect is in flight.
 */
export type SshStatus = "connected" | "disconnected" | "reconnecting";

type State = {
  env: WorkspaceEnv;
  distros: WslDistro[];
  loading: boolean;
  error: string | null;
  /** Liveness of the current SSH connection (window-level, one host per window). */
  sshStatus: SshStatus;
  /** Reconnect attempts made since the current drop (0 when connected). */
  reconnectAttempts: number;
  /** Epoch ms of the next scheduled auto-retry (null when none/stopped/in-flight). */
  nextAttemptAt: number | null;
  /** Bumped after a successful reconnect so open file tabs re-read their content. */
  reconnectGeneration: number;
  setEnv: (env: WorkspaceEnv) => void;
  setSshStatus: (status: SshStatus) => void;
  setReconnectAttempts: (attempts: number) => void;
  setNextAttemptAt: (ts: number | null) => void;
  bumpReconnectGeneration: () => void;
  refreshDistros: () => Promise<WslDistro[]>;
};

export const LOCAL_WORKSPACE: WorkspaceEnv = { kind: "local" };

export const useWorkspaceEnvStore = create<State>((set) => ({
  env: LOCAL_WORKSPACE,
  distros: [],
  loading: false,
  error: null,
  sshStatus: "connected",
  reconnectAttempts: 0,
  nextAttemptAt: null,
  reconnectGeneration: 0,
  setEnv: (env) => {
    // Switching workspace resets the SSH liveness model (the new host, if any,
    // is considered freshly connected).
    set({
      env,
      sshStatus: "connected",
      reconnectAttempts: 0,
      nextAttemptAt: null,
    });
    if (env.kind === "wsl") void setLastWslDistro(env.distro);
  },
  setSshStatus: (sshStatus) => set({ sshStatus }),
  setReconnectAttempts: (reconnectAttempts) => set({ reconnectAttempts }),
  setNextAttemptAt: (nextAttemptAt) => set({ nextAttemptAt }),
  bumpReconnectGeneration: () =>
    set((s) => ({ reconnectGeneration: s.reconnectGeneration + 1 })),
  refreshDistros: async () => {
    set({ loading: true, error: null });
    try {
      const distros = await invoke<WslDistro[]>("wsl_list_distros");
      set({ distros, loading: false });
      return distros;
    } catch (e) {
      set({ distros: [], loading: false, error: String(e) });
      return [];
    }
  },
}));

export function currentWorkspaceEnv(): WorkspaceEnv {
  return useWorkspaceEnvStore.getState().env;
}

export function workspaceScopeKey(env: WorkspaceEnv): string {
  if (env.kind === "wsl") return `wsl:${env.distro}`;
  if (env.kind === "ssh") return `ssh:${env.host}`;
  return "local";
}

export function currentWorkspaceScopeKey(): string {
  return workspaceScopeKey(currentWorkspaceEnv());
}

/** Imperative setter for non-React modules (e.g. the terminal session manager). */
export function setSshStatus(status: SshStatus): void {
  useWorkspaceEnvStore.getState().setSshStatus(status);
}

export function currentSshStatus(): SshStatus {
  return useWorkspaceEnvStore.getState().sshStatus;
}

export async function getWslHome(distro: string): Promise<string> {
  return invoke<string>("wsl_home", { distro });
}

/** Establishes the SSH master connection and installs the remote helper. */
export async function connectSsh(host: string): Promise<SshConnectInfo> {
  return invoke<SshConnectInfo>("ssh_connect", { host });
}

export async function disconnectSsh(host: string): Promise<void> {
  await invoke("ssh_disconnect", { host });
}

export async function listSshHosts(): Promise<SshHostEntry[]> {
  return invoke<SshHostEntry[]>("ssh_list_hosts");
}

export async function getSshHome(host: string): Promise<string> {
  return invoke<string>("ssh_home", { host });
}
