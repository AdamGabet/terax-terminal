import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { SavedTerminalLayout } from "@/modules/terminal/lib/savedLayouts";
import { normalizeRestartAllowlist } from "@/modules/terminal/lib/savedLayouts";
import { useEffect, useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  layouts: SavedTerminalLayout[];
  restartAllowlist: string[];
  canSave: boolean;
  onSave: (name: string) => void;
  onLoad: (layout: SavedTerminalLayout) => void;
  onDelete: (id: string) => void;
  onAllowlistChange: (commands: string[]) => void;
};

export function SavedLayoutsDialog({
  open,
  onOpenChange,
  layouts,
  restartAllowlist,
  canSave,
  onSave,
  onLoad,
  onDelete,
  onAllowlistChange,
}: Props) {
  const [name, setName] = useState("");
  const [allowlist, setAllowlist] = useState("");

  useEffect(() => {
    if (!open) return;
    setName("");
    setAllowlist(restartAllowlist.join(", "));
  }, [open, restartAllowlist]);

  const commitAllowlist = () => {
    const commands = normalizeRestartAllowlist(allowlist.split(/[\s,]+/));
    setAllowlist(commands.join(", "));
    onAllowlistChange(commands);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Saved terminal layouts</DialogTitle>
          <DialogDescription>
            Restore terminal tabs, split arrangement, directories, and
            workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <label htmlFor="layout-name" className="text-xs font-medium">
            Save current terminal layout
          </label>
          <div className="flex gap-2">
            <Input
              id="layout-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Layout name"
              onKeyDown={(event) => {
                if (event.key === "Enter" && name.trim() && canSave) {
                  onSave(name);
                  setName("");
                }
              }}
            />
            <Button
              disabled={!name.trim() || !canSave}
              onClick={() => {
                onSave(name);
                setName("");
              }}
            >
              Save
            </Button>
          </div>
        </div>

        <div className="grid gap-2">
          <label htmlFor="restart-allowlist" className="text-xs font-medium">
            Commands allowed to restart
          </label>
          <Input
            id="restart-allowlist"
            value={allowlist}
            onChange={(event) => setAllowlist(event.target.value)}
            onBlur={commitAllowlist}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitAllowlist();
            }}
            placeholder="bash, claude, opencode, codex"
          />
          <p className="text-xs text-muted-foreground">
            Only a matching executable name is saved. Arguments are never
            stored.
          </p>
        </div>

        <div className="grid max-h-64 gap-2 overflow-y-auto">
          {layouts.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              No saved layouts yet.
            </div>
          ) : (
            layouts.map((layout) => (
              <div
                key={layout.id}
                className="flex items-center gap-3 rounded-lg border border-border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{layout.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {workspaceLabel(layout)} · {layout.tabs.length} terminal
                    {layout.tabs.length === 1 ? "" : "s"}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onLoad(layout)}
                >
                  Load
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onDelete(layout.id)}
                >
                  Delete
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function workspaceLabel(layout: SavedTerminalLayout): string {
  const env = layout.workspace;
  if (env.kind === "ssh") return `SSH ${env.host}`;
  if (env.kind === "wsl") return `WSL ${env.distro}`;
  return "Local";
}
