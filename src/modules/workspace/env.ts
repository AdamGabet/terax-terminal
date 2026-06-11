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

type State = {
  env: WorkspaceEnv;
  distros: WslDistro[];
  loading: boolean;
  error: string | null;
  setEnv: (env: WorkspaceEnv) => void;
  refreshDistros: () => Promise<WslDistro[]>;
};

export const LOCAL_WORKSPACE: WorkspaceEnv = { kind: "local" };

export const useWorkspaceEnvStore = create<State>((set) => ({
  env: LOCAL_WORKSPACE,
  distros: [],
  loading: false,
  error: null,
  setEnv: (env) => {
    set({ env });
    if (env.kind === "wsl") void setLastWslDistro(env.distro);
  },
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
