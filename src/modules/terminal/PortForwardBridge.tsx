import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { currentWorkspaceEnv, useWorkspaceEnvStore } from "@/modules/workspace";
import { usePortForwardStore } from "./portForwardStore";

type PortDetected = { host: string; port: number };
type Forward = { host: string; localPort: number; remotePort: number };

// Module-level so re-mounts don't replay offers, and live forwards survive a
// component remount (only a full window reload clears them).
const offered = new Set<string>();
const forwards: Forward[] = [];
const LISTEN_POLL_MS = 5000;

const key = (host: string, port: number) => `${host}:${port}`;

export async function handleDetectedPort({
  host,
  port,
}: PortDetected): Promise<void> {
  const k = key(host, port);
  if (offered.has(k)) return;
  offered.add(k);

  // Verify it's genuinely listening before offering — kills false positives
  // from a port number that merely appeared in logged text.
  let listening = false;
  try {
    listening = await invoke<boolean>("ssh_port_listening", { host, port });
  } catch {
    listening = false;
  }
  if (!listening) {
    // Let a later, real server start re-trigger the offer.
    offered.delete(k);
    return;
  }

  usePortForwardStore.getState().upsertOffer(host, port);

  toast(`Port ${port} detected on ${host}`, {
    duration: 12000,
    action: {
      label: "Forward & Open",
      onClick: () => void forwardAndOpen(host, port),
    },
  });
}

export async function forwardAndOpen(
  host: string,
  remotePort: number,
): Promise<void> {
  try {
    const localPort = await invoke<number>("ssh_forward_port", {
      host,
      remotePort,
    });
    forwards.push({ host, localPort, remotePort });
    usePortForwardStore.getState().markForwarded(host, remotePort, localPort);
    await openUrl(`http://localhost:${localPort}`);
    if (localPort !== remotePort) {
      toast.success(
        `Forwarded ${host}:${remotePort} → localhost:${localPort}`,
      );
    }
  } catch (e) {
    toast.error(`Port forward failed: ${String(e)}`);
  }
}

/**
 * Manually forward a port the user typed in. Only valid in an SSH workspace
 * (forwards go over the host's ControlMaster). Verifies the port is actually
 * listening before forwarding so we don't create a dead tunnel.
 */
export async function manualForwardPort(port: number): Promise<void> {
  const env = currentWorkspaceEnv();
  if (env.kind !== "ssh") {
    toast.error("Port forwarding is only available on an SSH connection");
    return;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    toast.error("Enter a port between 1 and 65535");
    return;
  }
  const { host } = env;
  const k = key(host, port);
  const existing = usePortForwardStore
    .getState()
    .offers.find((o) => o.host === host && o.port === port);
  if (existing?.forwardedLocalPort != null) {
    await openUrl(`http://localhost:${existing.forwardedLocalPort}`);
    return;
  }

  let listening = false;
  try {
    listening = await invoke<boolean>("ssh_port_listening", { host, port });
  } catch {
    listening = false;
  }
  if (!listening) {
    toast.error(`Nothing is listening on port ${port} on ${host}`);
    return;
  }

  offered.add(k);
  usePortForwardStore.getState().upsertOffer(host, port);
  await forwardAndOpen(host, port);
}

/** Opens the local end of an already-forwarded port in the browser. */
export async function openForwardedPort(localPort: number): Promise<void> {
  await openUrl(`http://localhost:${localPort}`);
}

export function dismissPortOffer(host: string, port: number): void {
  usePortForwardStore.getState().removeOffer(host, port);
  offered.delete(key(host, port));
}

export async function stopPortForward(
  host: string,
  remotePort: number,
): Promise<void> {
  try {
    await cancelForward(host, remotePort, {
      removeOffer: true,
      releaseOffer: true,
      ignoreCancelError: false,
    });
  } catch (e) {
    toast.error(`Port cancel failed: ${String(e)}`);
  }
}

function removeStoppedPort(host: string, remotePort: number): void {
  void cancelForward(host, remotePort, {
    removeOffer: true,
    releaseOffer: true,
    ignoreCancelError: true,
  });
}

async function cancelForward(
  host: string,
  remotePort: number,
  opts: { removeOffer: boolean; releaseOffer: boolean; ignoreCancelError: boolean },
): Promise<void> {
  const idx = forwards.findIndex(
    (f) => f.host === host && f.remotePort === remotePort,
  );
  if (idx !== -1) {
    const f = forwards[idx];
    try {
      await invoke("ssh_cancel_port", {
        host: f.host,
        localPort: f.localPort,
        remotePort: f.remotePort,
      });
      forwards.splice(idx, 1);
    } catch (e) {
      if (!opts.ignoreCancelError) throw e;
      forwards.splice(idx, 1);
    }
  }
  if (opts.removeOffer) usePortForwardStore.getState().removeOffer(host, remotePort);
  if (opts.releaseOffer) offered.delete(key(host, remotePort));
}

function cancelForwardsFor(host: string): void {
  usePortForwardStore.getState().removeHost(host);
  for (let i = forwards.length - 1; i >= 0; i--) {
    const f = forwards[i];
    if (f.host !== host) continue;
    forwards.splice(i, 1);
    void invoke("ssh_cancel_port", {
      host: f.host,
      localPort: f.localPort,
      remotePort: f.remotePort,
    }).catch(() => {});
    offered.delete(key(f.host, f.remotePort));
  }
}

async function checkOfferStillListening(host: string, port: number): Promise<void> {
  let listening = true;
  try {
    listening = await invoke<boolean>("ssh_port_listening", { host, port });
  } catch {
    // If the probe fails, keep the row rather than hiding a still-live server.
    listening = true;
  }
  if (!listening) removeStoppedPort(host, port);
}

/**
 * Listens for `terax:port-detected` (emitted by the PTY reader when an SSH
 * terminal prints a "listening on :PORT" line) and offers a one-click
 * forward-and-open. Forwards are torn down when the window leaves the host.
 */
export function PortForwardBridge() {
  const offers = usePortForwardStore((s) => s.offers);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<PortDetected>("terax:port-detected", (e) => {
      void handleDetectedPort(e.payload);
    })
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (offers.length === 0) return;
    const check = () => {
      for (const offer of usePortForwardStore.getState().offers) {
        void checkOfferStillListening(offer.host, offer.port);
      }
    };
    const timer = window.setInterval(check, LISTEN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [offers.length]);

  const env = useWorkspaceEnvStore((s) => s.env);
  const prevHostRef = useRef<string | null>(
    env.kind === "ssh" ? env.host : null,
  );
  useEffect(() => {
    const host = env.kind === "ssh" ? env.host : null;
    const prev = prevHostRef.current;
    if (prev && prev !== host) cancelForwardsFor(prev);
    prevHostRef.current = host;
  }, [env]);

  return null;
}
