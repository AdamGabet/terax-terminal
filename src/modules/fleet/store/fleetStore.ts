import { useEffect } from "react";
import { create } from "zustand";
import {
  currentWorkspaceScopeKey,
  useWorkspaceEnvStore,
} from "@/modules/workspace";
import {
  fleetList,
  fleetListOpencode,
  isLiveAgent,
  mergeRemembered,
  type FleetAgent,
  type RememberedSession,
} from "../lib/fleet";

const POLL_MS = 5000;
const MAX_BACKOFF_MS = 60_000;
const REMEMBERED_KEY = "terax.fleet.remembered.";

function loadRemembered(scope: string): Record<string, RememberedSession> {
  try {
    const raw = localStorage.getItem(REMEMBERED_KEY + scope);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveRemembered(
  scope: string,
  remembered: Record<string, RememberedSession>,
): void {
  try {
    localStorage.setItem(REMEMBERED_KEY + scope, JSON.stringify(remembered));
  } catch {
    // Storage unavailable: the list just won't survive a reload.
  }
}

type FleetState = {
  /** Workspace scope the current `agents` belong to. */
  scope: string;
  agents: FleetAgent[];
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
  /** Sessions that went busy → idle since the user last looked at them. */
  unseenDone: Record<string, true>;
  /** Every session seen in this scope's listings (capped), by sessionId. */
  remembered: Record<string, RememberedSession>;
  refresh: () => Promise<void>;
  markSeen: (sessionId: string) => void;
  forget: (sessionId: string) => void;
};

export const useFleetStore = create<FleetState>((set, get) => ({
  scope: currentWorkspaceScopeKey(),
  agents: [],
  error: null,
  loading: false,
  updatedAt: null,
  unseenDone: {},
  remembered: loadRemembered(currentWorkspaceScopeKey()),

  refresh: async () => {
    const scope = currentWorkspaceScopeKey();
    set({ loading: true });
    try {
      // Stopped sessions belong under "Recent / gone" (via `remembered`),
      // not in the live list.
      // opencode is optional: its failure must not hide the Claude listing.
      const [claude, opencode] = await Promise.all([
        fleetList(),
        fleetListOpencode().catch(() => [] as FleetAgent[]),
      ]);
      const agents = [...claude.filter(isLiveAgent), ...opencode];
      if (scope !== currentWorkspaceScopeKey()) {
        set({ loading: false });
        return;
      }
      const prev = get();
      const sameScope = prev.scope === scope;
      const unseenDone: Record<string, true> = {};
      for (const a of agents) {
        const before = sameScope
          ? prev.agents.find((p) => p.sessionId === a.sessionId)
          : undefined;
        const finished = before?.status === "busy" && a.status === "idle";
        if (finished || (sameScope && prev.unseenDone[a.sessionId])) {
          unseenDone[a.sessionId] = true;
        }
      }
      const remembered = mergeRemembered(
        sameScope ? prev.remembered : loadRemembered(scope),
        agents,
        Date.now(),
      );
      saveRemembered(scope, remembered);
      set({
        scope,
        agents,
        unseenDone,
        remembered,
        error: null,
        loading: false,
        updatedAt: Date.now(),
      });
    } catch (e) {
      if (scope !== currentWorkspaceScopeKey()) {
        set({ loading: false });
        return;
      }
      set({ scope, error: String(e), loading: false });
    }
  },

  markSeen: (sessionId) =>
    set((s) => {
      if (!s.unseenDone[sessionId]) return s;
      const { [sessionId]: _, ...rest } = s.unseenDone;
      return { unseenDone: rest };
    }),

  forget: (sessionId) =>
    set((s) => {
      if (!s.remembered[sessionId]) return s;
      const { [sessionId]: _, ...rest } = s.remembered;
      saveRemembered(s.scope, rest);
      return { remembered: rest };
    }),
}));

// Polling runs only while at least one fleet view is on screen; failures
// (host unreachable, claude missing) back off exponentially.
let watchers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let backoff = POLL_MS;

function schedule(delay: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, delay);
}

async function tick() {
  timer = null;
  if (watchers === 0) return;
  await useFleetStore.getState().refresh();
  backoff = useFleetStore.getState().error
    ? Math.min(backoff * 2, MAX_BACKOFF_MS)
    : POLL_MS;
  if (watchers > 0) schedule(backoff);
}

/** Immediate refresh (resets backoff), e.g. after a stop or a manual click. */
export function refreshFleetNow(): Promise<void> {
  backoff = POLL_MS;
  if (watchers > 0) schedule(POLL_MS);
  return useFleetStore.getState().refresh();
}

export function useFleetPolling(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    watchers++;
    if (watchers === 1) {
      backoff = POLL_MS;
      void tick();
    }
    return () => {
      watchers--;
      if (watchers === 0 && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [active]);
}

// Switching host: drop the old listing and poll the new one right away.
useWorkspaceEnvStore.subscribe((state, prev) => {
  if (state.env === prev.env) return;
  useFleetStore.setState({
    scope: currentWorkspaceScopeKey(),
    agents: [],
    error: null,
    loading: false,
    updatedAt: null,
    unseenDone: {},
    remembered: loadRemembered(currentWorkspaceScopeKey()),
  });
  if (watchers > 0) void refreshFleetNow();
});
