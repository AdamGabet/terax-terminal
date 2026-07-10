import { create } from "zustand";

export type PortOffer = {
  host: string;
  port: number;
  at: number;
  forwardedLocalPort: number | null;
};

type State = {
  offers: PortOffer[];
  upsertOffer: (host: string, port: number) => void;
  markForwarded: (host: string, port: number, localPort: number) => void;
  removeOffer: (host: string, port: number) => void;
  removeHost: (host: string) => void;
};

const key = (host: string, port: number) => `${host}:${port}`;

export const usePortForwardStore = create<State>((set) => ({
  offers: [],
  upsertOffer: (host, port) =>
    set((s) => {
      const k = key(host, port);
      if (s.offers.some((o) => key(o.host, o.port) === k)) return s;
      return {
        offers: [{ host, port, at: Date.now(), forwardedLocalPort: null }, ...s.offers],
      };
    }),
  markForwarded: (host, port, localPort) =>
    set((s) => ({
      offers: s.offers.map((o) =>
        o.host === host && o.port === port
          ? { ...o, forwardedLocalPort: localPort }
          : o,
        ),
    })),
  removeOffer: (host, port) =>
    set((s) => ({
      offers: s.offers.filter((o) => o.host !== host || o.port !== port),
    })),
  removeHost: (host) =>
    set((s) => ({ offers: s.offers.filter((o) => o.host !== host) })),
}));
