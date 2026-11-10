// A small symmetric RPC peer over any message channel (WebSocket, chrome Port).

import type { Envelope } from "./wire.js";

type Handler = (params: any) => unknown | Promise<unknown>;

export interface RpcPeerOptions {
  send: (env: Envelope) => void;
  /** Default request timeout. Notebook reviews can wait on the user, so callers override per call. */
  timeoutMs?: number;
}

export class RpcError extends Error {}

export class RpcPeer {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private handlers = new Map<string, Handler>();
  private eventHandlers = new Map<string, Set<(params: any) => void>>();
  private readonly sendFn: (env: Envelope) => void;
  private readonly timeoutMs: number;

  constructor(opts: RpcPeerOptions) {
    this.sendFn = opts.send;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  handle(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  on(event: string, handler: (params: any) => void): () => void {
    let set = this.eventHandlers.get(event);
    if (!set) this.eventHandlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const ms = timeoutMs ?? this.timeoutMs;
      const timer = ms > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out after ${Math.round(ms / 1000)}s`));
      }, ms) : undefined;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.sendFn({ kind: "req", id, method, params });
      } catch (e) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new RpcError(String(e)));
      }
    });
  }

  emit(method: string, params: unknown): void {
    try {
      this.sendFn({ kind: "evt", method, params });
    } catch {
      // A closed channel drops events; requests surface the failure.
    }
  }

  /** Feed an incoming envelope. */
  async receive(env: Envelope): Promise<void> {
    if (env.kind === "res") {
      const p = this.pending.get(env.id);
      if (!p) return;
      this.pending.delete(env.id);
      if (p.timer) clearTimeout(p.timer);
      if (env.ok) p.resolve(env.result);
      else p.reject(new RpcError(env.error));
      return;
    }
    if (env.kind === "evt") {
      this.eventHandlers.get(env.method)?.forEach((h) => {
        try {
          h(env.params);
        } catch (e) {
          console.error(`event ${env.method} handler failed`, e);
        }
      });
      return;
    }
    const handler = this.handlers.get(env.method);
    if (!handler) {
      this.reply(env.id, false, `unknown method ${env.method}`);
      return;
    }
    try {
      const result = await handler(env.params);
      this.reply(env.id, true, result);
    } catch (e) {
      this.reply(env.id, false, e instanceof Error ? e.message : String(e));
    }
  }

  private reply(id: number, ok: boolean, payload: unknown) {
    try {
      this.sendFn(ok ? { kind: "res", id, ok: true, result: payload ?? null } : { kind: "res", id, ok: false, error: String(payload) });
    } catch {
      // Peer went away.
    }
  }

  /** Reject everything in flight, e.g. when the channel closes. */
  failAll(reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(reason));
      this.pending.delete(id);
    }
  }
}
