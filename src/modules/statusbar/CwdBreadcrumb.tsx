import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowDown01Icon,
  Folder01Icon,
  Home03Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { type Segment, segmentsFromCwd, splitSegments } from "./lib/pathUtils";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
};

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return "/";
  return path.slice(0, i);
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? path : path.slice(i + 1);
}

export function CwdBreadcrumb({ cwd, filePath, home, onCd }: Props) {
  // 0 = show the whole path; otherwise keep root + this many trailing segments.
  const cap = usePreferencesStore((s) => s.cwdMaxSegments);

  // File mode: dir segments navigate; filename is the terminal leaf.
  if (filePath) {
    const dir = dirname(filePath);
    const name = basename(filePath);
    const { head, collapsed, visible } = splitSegments(
      segmentsFromCwd(dir, home),
      cap,
    );
    return (
      <Breadcrumb>
        <BreadcrumbList className="gap-1 text-xs sm:gap-1.5">
          {head ? (
            <BreadcrumbSegment
              label={head.label}
              isHome={head.isHome}
              onClick={() => onCd(head.fullPath)}
            />
          ) : null}
          {collapsed.length > 0 ? (
            <CollapsedSegments segments={collapsed} onCd={onCd} />
          ) : null}
          {visible.map((s) => (
            <BreadcrumbSegment
              key={s.fullPath}
              label={s.label}
              isHome={s.isHome}
              onClick={() => onCd(s.fullPath)}
            />
          ))}
          <BreadcrumbItem>
            <BreadcrumbPage className="text-foreground">{name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (!cwd) {
    return (
      <span className="text-xs text-muted-foreground/70">no directory</span>
    );
  }

  const { head, collapsed, visible } = splitSegments(
    segmentsFromCwd(cwd, home),
    cap,
  );
  // The current directory is the last visible segment (or the root itself when
  // the cwd is home / filesystem root).
  const current: Segment | null =
    visible.length > 0 ? visible[visible.length - 1] : head;
  const parents = visible.length > 0 ? visible.slice(0, -1) : [];
  const rootIsCurrent = visible.length === 0;

  return (
    <Breadcrumb>
      <BreadcrumbList className="gap-1 text-xs sm:gap-1.5">
        {head && !rootIsCurrent ? (
          <BreadcrumbSegment
            label={head.label}
            isHome={head.isHome}
            onClick={() => onCd(head.fullPath)}
          />
        ) : null}
        {collapsed.length > 0 ? (
          <CollapsedSegments segments={collapsed} onCd={onCd} />
        ) : null}
        {parents.map((s) => (
          <BreadcrumbSegment
            key={s.fullPath}
            label={s.label}
            isHome={s.isHome}
            onClick={() => onCd(s.fullPath)}
          />
        ))}
        {current ? (
          <BreadcrumbItem>
            <CurrentSegmentDropdown
              label={current.label}
              path={current.fullPath}
              onCd={onCd}
            />
          </BreadcrumbItem>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function BreadcrumbSegment({
  label,
  isHome,
  onClick,
}: {
  label: string;
  isHome: boolean;
  onClick: () => void;
}) {
  return (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink asChild>
          <button type="button" onClick={onClick} className="cursor-pointer">
            <Badge
              variant="outline"
              className="gap-1 text-muted-foreground hover:text-foreground"
            >
              {isHome ? (
                <HugeiconsIcon
                  icon={Home03Icon}
                  className="size-3"
                  strokeWidth={1.75}
                />
              ) : null}
              {isHome ? "Home" : label}
            </Badge>
          </button>
        </BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="[&>svg]:size-3" />
    </>
  );
}

function CurrentSegmentDropdown({
  label,
  path,
  onCd,
}: {
  label: string;
  path: string;
  onCd: (p: string) => void;
}) {
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const dirs = await invoke<string[]>("list_subdirs", {
        path,
        showHidden,
        workspace: currentWorkspaceEnv(),
      });
      setChildren(dirs);
    } catch (e) {
      setError(String(e));
      setChildren([]);
    }
  }, [path, showHidden]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <BreadcrumbPage className="flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-foreground hover:bg-accent">
          {label === "~" ? (
            <>
              <HugeiconsIcon
                icon={Home03Icon}
                className="size-3"
                strokeWidth={1.75}
              />
              Home
            </>
          ) : (
            label
          )}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className="size-3 opacity-70"
            strokeWidth={2}
          />
        </BreadcrumbPage>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {children === null ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            Loading…
          </div>
        ) : children.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {error ?? "No subfolders"}
          </div>
        ) : (
          children.map((name) => (
            <DropdownMenuItem
              key={name}
              onSelect={() =>
                onCd(path.endsWith("/") ? `${path}${name}` : `${path}/${name}`)
              }
            >
              <HugeiconsIcon
                icon={Folder01Icon}
                className="size-3.5 text-muted-foreground"
                strokeWidth={1.75}
              />
              {name}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CollapsedSegments({
  segments,
  onCd,
}: {
  segments: { fullPath: string; label: string; isHome: boolean }[];
  onCd: (p: string) => void;
}) {
  return (
    <span className="contents">
      <BreadcrumbItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="Show hidden folders"
              className="flex items-center rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <HugeiconsIcon
                icon={MoreHorizontalIcon}
                className="size-3"
                strokeWidth={1.75}
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            {segments.map((s) => (
              <DropdownMenuItem
                key={s.fullPath}
                onSelect={() => onCd(s.fullPath)}
              >
                <HugeiconsIcon
                  icon={s.isHome ? Home03Icon : Folder01Icon}
                  className="size-3.5 text-muted-foreground"
                  strokeWidth={1.75}
                />
                <span className="truncate">{s.isHome ? "Home" : s.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="[&>svg]:size-3" />
    </span>
  );
}
