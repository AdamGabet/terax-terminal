import { Channel, invoke } from "@tauri-apps/api/core";
import type { WorkspaceEnv } from "@/modules/workspace";

export type DapExitInfo = {
  code: number | null;
  stderrTail: string;
  reason: string | null;
};

type DapMessage = {
  seq: number;
  type: "request" | "response" | "event";
  // response
  request_seq?: number;
  success?: boolean;
  command?: string;
  message?: string;
  body?: unknown;
  // event
  event?: string;
  // reverse request
  arguments?: unknown;
};

export type DapEventHandler = (event: string, body: unknown) => void;

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * DAP connection over the Rust framed-process transport (`lsp_spawn` — DAP
 * shares LSP's Content-Length framing). One connection = one adapter process.
 */
export class DapConnection {
  private sessionId: number | null = null;
  private seq = 1;
  private closed = false;
  private pending = new Map<
    number,
    {
      resolve: (body: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private onEventCb: DapEventHandler | null = null;
  private onExitCb: ((info: DapExitInfo) => void) | null = null;
  exitInfo: DapExitInfo | null = null;

  async start(config: {
    command: string;
    args: string[];
    root: string;
    env?: Record<string, string>;
    workspace: WorkspaceEnv;
  }): Promise<void> {
    const decoder = new TextDecoder();
    const onMessage = new Channel<ArrayBuffer>();
    onMessage.onmessage = (buf) => this.handleMessage(decoder.decode(buf));
    const onExit = new Channel<DapExitInfo>();
    onExit.onmessage = (info) => {
      this.exitInfo = info;
      this.closed = true;
      const err = new Error(
        info.reason ?? `debug adapter exited (code ${info.code ?? "?"})`,
      );
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.onExitCb?.(info);
    };
    this.sessionId = await invoke<number>("lsp_spawn", {
      command: config.command,
      args: config.args,
      env: config.env ?? null,
      root: config.root,
      maxRssMb: null,
      workspace: config.workspace,
      onMessage,
      onExit,
    });
  }

  onEvent(cb: DapEventHandler): void {
    this.onEventCb = cb;
  }

  onExit(cb: (info: DapExitInfo) => void): void {
    this.onExitCb = cb;
    if (this.exitInfo) cb(this.exitInfo);
  }

  request<T = unknown>(
    command: string,
    args?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.sessionId == null || this.closed) {
      return Promise.reject(new Error("debug adapter is not running"));
    }
    const seq = this.seq++;
    const payload = JSON.stringify({
      seq,
      type: "request",
      command,
      arguments: args ?? {},
    });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DAP ${command} timed out`));
      }, timeoutMs);
      this.pending.set(seq, {
        resolve: resolve as (body: unknown) => void,
        reject,
        timer,
      });
      void invoke("lsp_send", { id: this.sessionId, message: payload }).catch(
        (e) => {
          const p = this.pending.get(seq);
          if (p) {
            this.pending.delete(seq);
            clearTimeout(p.timer);
            p.reject(new Error(String(e)));
          }
        },
      );
    });
  }

  private handleMessage(text: string): void {
    let msg: DapMessage;
    try {
      msg = JSON.parse(text) as DapMessage;
    } catch {
      return;
    }
    if (msg.type === "response" && msg.request_seq != null) {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      clearTimeout(p.timer);
      if (msg.success) p.resolve(msg.body);
      else p.reject(new Error(msg.message ?? `${msg.command} failed`));
    } else if (msg.type === "event" && msg.event) {
      this.onEventCb?.(msg.event, msg.body);
    } else if (msg.type === "request") {
      // Reverse requests (runInTerminal, startDebugging): decline politely.
      this.send({
        type: "response",
        request_seq: msg.seq,
        success: false,
        command: msg.command,
        message: "not supported by terax",
      });
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.sessionId == null || this.closed) return;
    void invoke("lsp_send", {
      id: this.sessionId,
      message: JSON.stringify({ seq: this.seq++, ...msg }),
    }).catch(() => {});
  }

  close(): void {
    if (this.closed) {
      this.sessionId = null;
      return;
    }
    this.closed = true;
    if (this.sessionId != null) {
      void invoke("lsp_kill", { id: this.sessionId }).catch(() => {});
      this.sessionId = null;
    }
  }
}
