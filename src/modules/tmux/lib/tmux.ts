import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

export type TmuxSessionInfo = {
  name: string;
  path: string;
  command: string;
  windows: number;
  created: number;
};

export function tmuxAvailable(): Promise<boolean> {
  return invoke<boolean>("tmux_available", { workspace: currentWorkspaceEnv() });
}

export function tmuxList(): Promise<TmuxSessionInfo[]> {
  return invoke<TmuxSessionInfo[]>("tmux_list", {
    workspace: currentWorkspaceEnv(),
  });
}

export function tmuxKill(name: string): Promise<void> {
  return invoke("tmux_kill", { workspace: currentWorkspaceEnv(), name });
}
