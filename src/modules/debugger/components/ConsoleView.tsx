import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { useDebuggerStore } from "../lib/store";

const KIND_CLASS: Record<string, string> = {
  stdout: "text-foreground",
  stderr: "text-amber-600 dark:text-amber-400",
  input: "text-sky-600 dark:text-sky-400",
  result: "text-foreground",
  error: "text-destructive",
  info: "text-muted-foreground",
};

/** Program output + a REPL evaluating in the selected paused frame. */
export function ConsoleView() {
  const entries = useDebuggerStore((s) => s.console);
  const paused = useDebuggerStore((s) => s.paused);
  const status = useDebuggerStore((s) => s.status);
  const evaluate = useDebuggerStore((s) => s.evaluate);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const canEval = paused !== null;

  const submit = () => {
    const expr = input.trim();
    if (!expr || !canEval) return;
    evaluate(expr);
    setHistory((h) => [expr, ...h.slice(0, 99)]);
    setHistIdx(-1);
    setInput("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-[11px] leading-4"
      >
        {entries.map((e) => (
          <pre
            key={e.id}
            className={cn(
              "whitespace-pre-wrap break-words",
              KIND_CLASS[e.kind] ?? "text-foreground",
            )}
          >
            {e.kind === "input" ? `› ${e.text}` : e.text}
          </pre>
        ))}
      </div>
      <div className="border-t border-border/60 px-2 py-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "ArrowUp" && history.length > 0) {
              e.preventDefault();
              const idx = Math.min(histIdx + 1, history.length - 1);
              setHistIdx(idx);
              setInput(history[idx]);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const idx = histIdx - 1;
              setHistIdx(Math.max(idx, -1));
              setInput(idx >= 0 ? history[idx] : "");
            }
          }}
          disabled={!canEval}
          placeholder={
            canEval
              ? "evaluate in selected frame — e.g. x.shape"
              : status === "running"
                ? "pause to evaluate"
                : "start a session to evaluate"
          }
          spellCheck={false}
          className="w-full bg-transparent font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60 disabled:opacity-60"
        />
      </div>
    </div>
  );
}
