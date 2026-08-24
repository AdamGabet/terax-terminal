import { create } from "zustand";

type State = {
  recentCwds: string[];
  push: (cwd: string) => void;
};

export const useRecentCwdStore = create<State>((set) => ({
  recentCwds: [],
  push: (cwd) =>
    set((s) => {
      const filtered = s.recentCwds.filter((c) => c !== cwd);
      return { recentCwds: [cwd, ...filtered].slice(0, 5) };
    }),
}));
