import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { ThemePref } from "@/modules/settings/store";
import {
  CWD_MAX_SEGMENTS_PRESETS,
  FILE_PREVIEW_TABS_PRESETS,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACK_PRESETS,
  setAgentNotifications,
  setAutostart,
  setCwdMaxSegments,
  setDebuggerMcpEnabled,
  setMaxFilePreviewTabs,
  setRestoreWindowState,
  setShowHidden,
  setTerminalFontFamily,
  setTerminalLetterSpacing,
  setTerminalFontSize,
  setTerminalScrollback,
  setTerminalWebglEnabled,
  setZoomLevel,
} from "@/modules/settings/store";
import { useTheme } from "@/modules/theme";
import {
  ComputerIcon,
  Moon02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const APPEARANCE: {
  id: ThemePref;
  label: string;
  icon: typeof ComputerIcon;
}[] = [
  { id: "system", label: "System", icon: ComputerIcon },
  { id: "light", label: "Light", icon: Sun03Icon },
  { id: "dark", label: "Dark", icon: Moon02Icon },
];

const LETTER_SPACINGS = [-4, -3, -2, -1, 0, 1, 2, 3, 4] as const;

type McpInfo = {
  port: number;
  token: string;
  endpoint: string;
  addCommand: string;
};
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.05;

export function GeneralSection() {
  const { mode, setMode } = useTheme();

  const autostart = usePreferencesStore((s) => s.autostart);
  const restoreWindowState = usePreferencesStore((s) => s.restoreWindowState);
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const maxFilePreviewTabs = usePreferencesStore((s) => s.maxFilePreviewTabs);
  const cwdMaxSegments = usePreferencesStore((s) => s.cwdMaxSegments);
  const terminalWebglEnabled = usePreferencesStore(
    (s) => s.terminalWebglEnabled,
  );
  const terminalFontFamily = usePreferencesStore((s) => s.terminalFontFamily);
  const terminalLetterSpacing = usePreferencesStore(
    (s) => s.terminalLetterSpacing,
  );
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const terminalScrollback = usePreferencesStore((s) => s.terminalScrollback);
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  const agentNotifications = usePreferencesStore((s) => s.agentNotifications);
  const debuggerMcpEnabled = usePreferencesStore((s) => s.debuggerMcpEnabled);
  const [mcpInfo, setMcpInfo] = useState<McpInfo | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);

  // mcp_start is idempotent — fetch (or start) to render the connect command.
  useEffect(() => {
    if (!debuggerMcpEnabled) {
      setMcpInfo(null);
      return;
    }
    let alive = true;
    void invoke<McpInfo>("mcp_start")
      .then((info) => {
        if (alive) setMcpInfo(info);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [debuggerMcpEnabled]);

  const onToggleMcp = async (next: boolean) => {
    try {
      if (!next) await invoke("mcp_stop");
      await setDebuggerMcpEnabled(next);
    } catch (e) {
      console.error("debugger MCP toggle failed", e);
    }
  };

  useEffect(() => {
    let alive = true;
    void isEnabled()
      .then((on) => {
        if (!alive) return;
        if (on !== usePreferencesStore.getState().autostart) {
          void setAutostart(on);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const onToggleAutostart = async (next: boolean) => {
    try {
      if (next) await enable();
      else await disable();
      await setAutostart(next);
    } catch (e) {
      console.error("autostart toggle failed", e);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="General" description="Mode, editor, and startup." />

      <div className="flex flex-col gap-2">
        <Label>Appearance</Label>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setMode(o.id)}
              className={cn(
                "group flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border bg-card transition-all",
                mode === o.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border",
              )}
            >
              <HugeiconsIcon icon={o.icon} size={18} strokeWidth={1.5} />
              <span className="text-[11.5px]">{o.label}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          For theme, background and customization, see the{" "}
          <strong className="font-medium text-foreground">Themes</strong> tab.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Zoom</Label>
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-muted-foreground">
              UI zoom level
            </span>
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {Math.round(zoomLevel * 100)}%
            </span>
          </div>
          <Slider
            value={[zoomLevel]}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            onValueChange={(v) => void setZoomLevel(v[0] ?? 1)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Explorer</Label>
        <SettingRow
          title="Show hidden files"
          description="Include dot-prefixed files and folders (.env, .gitignore, .config) in the file explorer and search."
        >
          <Switch
            checked={showHidden}
            onCheckedChange={(v) => void setShowHidden(v)}
          />
        </SettingRow>
        <SettingRow
          title="Image & PDF preview tabs"
          description="Maximum image and PDF viewer tabs kept open at once. Opening more closes the oldest."
        >
          <Select
            value={String(maxFilePreviewTabs)}
            onValueChange={(v) => void setMaxFilePreviewTabs(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILE_PREVIEW_TABS_PRESETS.map((n) => (
                <SelectItem key={n} value={String(n)} className="text-[12px]">
                  {n === 0 ? "Unlimited" : `${n} ${n === 1 ? "tab" : "tabs"}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Status bar path length"
          description="How many trailing folders the status-bar path shows before collapsing the rest into a … menu. Applies to SSH too."
        >
          <Select
            value={String(cwdMaxSegments)}
            onValueChange={(v) => void setCwdMaxSegments(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CWD_MAX_SEGMENTS_PRESETS.map((n) => (
                <SelectItem key={n} value={String(n)} className="text-[12px]">
                  {n === 0 ? "Full path" : `${n} folders`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Terminal</Label>
        <SettingRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Use WebGL renderer
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="cursor-help text-[11px] text-muted-foreground/70 leading-none"
                      aria-label="More info about WebGL renderer"
                    >
                      ⓘ
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-65 text-[11px]">
                    xterm's WebGL renderer caches glyphs in a GPU texture atlas.
                    On some macOS setups (especially with Nerd Fonts), the atlas
                    corrupts and terminal text becomes unreadable. SSH terminals
                    automatically use the reliable DOM renderer. Turn this off
                    to use the DOM renderer locally too.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </span>
          }
          description="Hardware-accelerated local rendering. SSH terminals always use the reliable DOM renderer."
        >
          <Switch
            checked={terminalWebglEnabled}
            onCheckedChange={(v) => void setTerminalWebglEnabled(v)}
          />
        </SettingRow>
        <SettingRow
          title="Font family"
          description='Nerd Font name for icons (e.g. "CaskaydiaCove Nerd Font Mono"). Leave blank to auto-detect.'
        >
          <input
            type="text"
            value={terminalFontFamily}
            placeholder="Auto-detect"
            onChange={(e) => void setTerminalFontFamily(e.target.value)}
            className="h-8 w-48 rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-foreground/40"
          />
        </SettingRow>
        <SettingRow
          title="Letter spacing"
          description="Extra horizontal space between characters (px). Use negative values to tighten Nerd Fonts."
        >
          <Select
            value={String(terminalLetterSpacing)}
            onValueChange={(v) => void setTerminalLetterSpacing(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LETTER_SPACINGS.map((v) => (
                <SelectItem key={v} value={String(v)} className="text-[12px]">
                  {v > 0 ? `+${v}` : v} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title="Font size" description="Terminal text size.">
          <Select
            value={String(terminalFontSize)}
            onValueChange={(v) => void setTerminalFontSize(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_SIZES.map((size) => (
                <SelectItem
                  key={size}
                  value={String(size)}
                  className="text-[12px]"
                >
                  {size} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Scrollback"
          description="Lines of history kept per terminal. Higher uses more RAM (~3 KB / line)."
        >
          <Select
            value={String(terminalScrollback)}
            onValueChange={(v) => void setTerminalScrollback(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-36 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_SCROLLBACK_PRESETS.map((lines) => (
                <SelectItem
                  key={lines}
                  value={String(lines)}
                  className="text-[12px]"
                >
                  {lines.toLocaleString()} lines
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Agents</Label>
        <SettingRow
          title="Coding agent notifications"
          description="Alert when Claude Code or Codex running in a terminal needs your input or finishes. Needs-input sends a desktop notification; finished alerts stay in-app unless Terax is unfocused."
        >
          <Switch
            checked={agentNotifications}
            onCheckedChange={(v) => void setAgentNotifications(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Debugger</Label>
        <SettingRow
          title="MCP server"
          description="Let MCP clients (Claude Code) drive the Python debugger: place probes, launch scripts, read the execution map and snapshots. Loopback-only, protected by a per-run token."
        >
          <Switch
            checked={debuggerMcpEnabled}
            onCheckedChange={(v) => void onToggleMcp(v)}
          />
        </SettingRow>
        {debuggerMcpEnabled && mcpInfo ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11.5px] text-muted-foreground">
                Connect Claude Code (run once per Terax launch — the token
                rotates):
              </span>
              <button
                type="button"
                className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] hover:border-foreground/40"
                onClick={() => {
                  void writeText(mcpInfo.addCommand).then(() => {
                    setMcpCopied(true);
                    setTimeout(() => setMcpCopied(false), 1500);
                  });
                }}
              >
                {mcpCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <code className="select-all break-all rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
              {mcpInfo.addCommand}
            </code>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label>Startup</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="Launch at login"
            description="Open Terax automatically when you sign in."
          >
            <Switch
              checked={autostart}
              onCheckedChange={(v) => void onToggleAutostart(v)}
            />
          </SettingRow>
          <SettingRow
            title="Restore window position & size"
            description="Reopen the main window where you left it. Applies on next launch."
          >
            <Switch
              checked={restoreWindowState}
              onCheckedChange={(v) => void setRestoreWindowState(v)}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
