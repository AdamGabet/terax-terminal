import { cn } from "@/lib/utils";
import { formatValue } from "../lib/graphModel";
import type { ValueDesc } from "../lib/types";

/** One-line value summary with tensor/anomaly color coding. */
export function ValueBadge({
  desc,
  className,
}: {
  desc: ValueDesc | null | undefined;
  className?: string;
}) {
  const bad =
    (desc?.nonfinite ?? 0) > 0 ||
    (desc?.kind === "scalar" &&
      typeof desc.value === "string" &&
      (desc.value === "nan" || desc.value.includes("inf")));
  const isArray = desc?.kind === "tensor" || desc?.kind === "ndarray";
  return (
    <span
      className={cn(
        "whitespace-nowrap font-mono text-[11px]",
        bad
          ? "text-destructive"
          : isArray
            ? "text-sky-500 dark:text-sky-400"
            : "text-muted-foreground",
        className,
      )}
    >
      {formatValue(desc)}
    </span>
  );
}
