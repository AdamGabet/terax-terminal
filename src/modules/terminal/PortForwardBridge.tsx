import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { currentWorkspaceEnv, useWorkspaceEnvStore } from "@/modules/workspace";

type PortDetected = { host: string; port: number };
type Forward = { host: string; localPort: number; remotePort: number };

// Module-level so re-mounts don't replay offers, and live forwards survive a
// component remount (only a full window reload clears them).
const offered = new Set<string>();
const forwards: Forward[] = [];

const key = (host: string, port: number) => `${host}:${port}`;

async function handleDetected({ host, port }: PortDetected): Promise<void> {
  // Only act when this window is actually sitting on that SSH host.
  const env = currentWorkspaceEnv();
  if (env.kind !== "ssh" || env.host !== host) return;

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

  toast(`Port ${port} detected on ${host}`, {
    duration: 12000,
    action: {
      label: "Forward & Open",
      onClick: () => void forwardAndOpen(host, port),
    },
  });
}

async function forwardAndOpen(host: string, remotePort: number): Promise<void> {
  try {
    const localPort = await invoke<number>("ssh_forward_port", {
      host,
      remotePort,
    });
    forwards.push({ host, localPort, remotePort });
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

function cancelForwardsFor(host: string): void {
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

/**
 * Listens for `terax:port-detected` (emitted by the PTY reader when an SSH
 * terminal prints a "listening on :PORT" line) and offers a one-click
 * forward-and-open. Forwards are torn down when the window leaves the host.
 */
export function PortForwardBridge() {
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<PortDetected>("terax:port-detected", (e) => {
      void handleDetected(e.payload);
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
