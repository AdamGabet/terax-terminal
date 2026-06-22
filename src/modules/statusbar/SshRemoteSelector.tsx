import {
  Loading03Icon,
  PlugSocketIcon,
  PlusSignIcon,
  RefreshIcon,
  Unlink02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { reconnectSsh } from "@/modules/terminal";
import {
  connectSsh,
  disconnectSsh,
  LOCAL_WORKSPACE,
  listSshHosts,
  type SshHostEntry,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";

type Props = {
  onSelect: (env: WorkspaceEnv) => void;
};

/**
 * VS Code-style remote indicator: connects the whole window to an SSH host.
 * Hosts come from ~/.ssh/config; arbitrary `user@host` entry via the dialog.
 */
export function SshRemoteSelector({ onSelect }: Props) {
  const env = useWorkspaceEnvStore((s) => s.env);
  const sshStatus = useWorkspaceEnvStore((s) => s.sshStatus);
  const [hosts, setHosts] = useState<SshHostEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [manualHost, setManualHost] = useState("");

  const connectedHost = env.kind === "ssh" ? env.host : null;
  const dropped = connectedHost !== null && sshStatus !== "connected";
  const reconnecting = sshStatus === "reconnecting";

  const refreshHosts = async () => {
    setLoading(true);
    try {
      setHosts(await listSshHosts());
    } catch {
      setHosts([]);
    } finally {
      setLoading(false);
    }
  };

  const connect = async (rawHost: string) => {
    const host = rawHost.trim();
    if (!host || connecting) return;
    setConnecting(host);
    const toastId = toast.loading(`Connecting to ${host}…`, {
      description: "Establishing SSH session and installing the Terax helper",
    });
    try {
      await connectSsh(host);
      toast.success(`Connected to ${host}`, {
        id: toastId,
        description: undefined,
      });
      setDialogOpen(false);
      setManualHost("");
      onSelect({ kind: "ssh", host });
    } catch (e) {
      toast.error(`Could not connect to ${host}`, {
        id: toastId,
        description: String(e),
        duration: 8000,
      });
    } finally {
      setConnecting(null);
    }
  };

  const disconnect = async () => {
    if (!connectedHost) return;
    onSelect(LOCAL_WORKSPACE);
    try {
      await disconnectSsh(connectedHost);
    } catch {
      // Master may already be gone (network drop) — state is reset anyway.
    }
    toast.success(`Disconnected from ${connectedHost}`);
  };

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void refreshHosts()}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={
              dropped
                ? "flex h-6 shrink-0 items-center gap-1 rounded-sm bg-destructive/15 px-1.5 text-[11px] font-medium text-destructive outline-none hover:bg-destructive/25 focus:outline-none focus-visible:ring-0 data-[state=open]:bg-destructive/25"
                : connectedHost
                  ? "flex h-6 shrink-0 items-center gap-1 rounded-sm bg-primary/15 px-1.5 text-[11px] font-medium text-primary outline-none hover:bg-primary/25 focus:outline-none focus-visible:ring-0 data-[state=open]:bg-primary/25"
                  : "flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-0 data-[state=open]:bg-accent data-[state=open]:text-foreground"
            }
            title={
              dropped
                ? `Connection to ${connectedHost} lost — click to reconnect`
                : connectedHost
                  ? `Connected to ${connectedHost} over SSH`
                  : "Connect window to an SSH host"
            }
          >
            <HugeiconsIcon
              icon={connecting || reconnecting ? Loading03Icon : PlugSocketIcon}
              size={13}
              strokeWidth={1.75}
              className={
                connecting || reconnecting ? "animate-spin" : undefined
              }
            />
            {connectedHost ? (
              <span className="max-w-32 truncate">
                SSH: {connectedHost}
                {dropped
                  ? reconnecting
                    ? " (reconnecting…)"
                    : " (offline)"
                  : ""}
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          {dropped ? (
            <>
              <DropdownMenuItem
                disabled={reconnecting}
                onSelect={() => void reconnectSsh()}
              >
                <HugeiconsIcon
                  icon={reconnecting ? Loading03Icon : RefreshIcon}
                  size={13}
                  strokeWidth={1.75}
                  className={reconnecting ? "animate-spin" : undefined}
                />
                {reconnecting ? "Reconnecting…" : "Reconnect"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {connectedHost ? (
            <>
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                {dropped
                  ? `Disconnected from ${connectedHost}`
                  : `Connected to ${connectedHost}`}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void disconnect()}>
                <HugeiconsIcon
                  icon={Unlink02Icon}
                  size={13}
                  strokeWidth={1.75}
                />
                Disconnect
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
            SSH hosts (~/.ssh/config)
          </DropdownMenuLabel>
          {hosts.length === 0 ? (
            <DropdownMenuItem disabled>
              {loading ? "Loading hosts…" : "No hosts found"}
            </DropdownMenuItem>
          ) : (
            hosts.map((entry) => (
              <DropdownMenuItem
                key={entry.host}
                disabled={connecting !== null || entry.host === connectedHost}
                onSelect={() => void connect(entry.host)}
              >
                <span className="truncate">{entry.host}</span>
                {entry.host === connectedHost ? (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    current
                  </span>
                ) : null}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={connecting !== null}
            onSelect={() => setDialogOpen(true)}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={1.75} />
            Connect to Host…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Connect to SSH host</DialogTitle>
            <DialogDescription>
              Hostname, ssh-config alias, or user@host. Key-based auth is
              required (no password prompts).
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={manualHost}
            placeholder="user@server.example.com"
            onChange={(e) => setManualHost(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void connect(manualHost);
            }}
          />
          <DialogFooter>
            <Button
              size="sm"
              disabled={!manualHost.trim() || connecting !== null}
              onClick={() => void connect(manualHost)}
            >
              {connecting ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
