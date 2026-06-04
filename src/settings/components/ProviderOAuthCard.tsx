import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ModelInfo, ProviderInfo } from "@/modules/ai/config";
import {
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ProviderIcon } from "./ProviderIcon";

export type CodexAuthStatus = {
  loggedIn: boolean;
  email: string | null;
  accountId: string | null;
  expiresAt: number | null;
};

type Props = {
  provider: ProviderInfo;
  status: CodexAuthStatus | null;
  models: readonly ModelInfo[];
  onRefresh: () => void;
};

export function ProviderOAuthCard({
  provider,
  status,
  models,
  onRefresh,
}: Props) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={provider.id} size={15} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {status?.loggedIn ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={9}
              strokeWidth={2}
            />
            Connected
          </Badge>
        ) : null}
        <button
          type="button"
          onClick={() => void openUrl(provider.consoleUrl)}
          className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Manage account
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={11} strokeWidth={1.75} />
        </button>
      </div>

      <div className="flex items-center justify-between gap-3">
        {status === null ? (
          <span className="text-[11px] text-muted-foreground">Checking…</span>
        ) : status.loggedIn ? (
          <span className="truncate text-[11px] text-muted-foreground">
            {status.email ?? status.accountId ?? "Authenticated"}
          </span>
        ) : (
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            Run{" "}
            <code className="rounded bg-muted px-1 py-px font-mono text-[10.5px]">
              pnpm dlx @openai/codex login
            </code>{" "}
            in your terminal, then click Refresh.
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-[11px]"
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </div>

      {models.length > 0 ? (
        <div className="flex flex-col gap-1 border-t border-border/40 pt-2">
          <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Available models
          </span>
          {models.map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              <span className="flex-1 truncate text-[11.5px] font-medium leading-snug">
                {m.label}
              </span>
              <div className="flex shrink-0 gap-1">
                {m.tags?.includes("vision") && (
                  <Badge variant="secondary" className="h-4 px-1 text-[9.5px]">
                    vision
                  </Badge>
                )}
                {m.contextWindow ? (
                  <Badge variant="secondary" className="h-4 px-1 text-[9.5px]">
                    {Math.round(m.contextWindow / 1000)}K ctx
                  </Badge>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
