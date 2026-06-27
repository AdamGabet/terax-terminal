import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ComputerTerminal02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { tmuxKill, tmuxList, type TmuxSessionInfo } from "@/modules/tmux";

type Props = {
  available: boolean;
  onAttach: (name: string) => void;
};

export function TmuxSessionsPopover({ available, onAttach }: Props) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!available) return;
    setLoading(true);
    setError(null);
    try {
      setSessions(await tmuxList());
    } catch (e) {
      setError(String(e));
      setSessions([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open, available]);

  const kill = async (name: string) => {
    try {
      await tmuxKill(name);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={!available}
          title={
            available
              ? "tmux sessions"
              : "tmux is not installed on this host"
          }
          className="h-6 gap-1 px-2 text-[11px] disabled:opacity-50"
        >
          <HugeiconsIcon icon={ComputerTerminal02Icon} size={12} />
          tmux
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-96 gap-3 rounded-xl p-3">
        <PopoverHeader>
          <PopoverTitle className="text-sm">tmux sessions</PopoverTitle>
        </PopoverHeader>
        {loading ? <div className="text-xs text-muted-foreground">Loading…</div> : null}
        {error ? <div className="text-xs text-destructive">{error}</div> : null}
        {!loading && !error && sessions.length === 0 ? (
          <div className="text-xs text-muted-foreground">No terax-* sessions.</div>
        ) : null}
        <div className="flex max-h-80 flex-col gap-2 overflow-auto">
          {sessions.map((s) => (
            <div key={s.name} className="rounded-lg border border-border/70 p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{s.path || s.name}</div>
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                    {s.command || "shell"} · {s.windows} window{s.windows === 1 ? "" : "s"} · {ageLabel(s.created)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => onAttach(s.name)}>
                    Attach
                  </Button>
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => void kill(s.name)}>
                    Kill
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ageLabel(created: number): string {
  if (!created) return "unknown age";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - created));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
