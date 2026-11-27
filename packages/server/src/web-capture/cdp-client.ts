import { WebSocket } from "ws";
import http from "node:http";

export interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Validates and normalizes a CDP endpoint to loopback-only URLs (prevents SSRF).
 * Accepts bare port ("9222"), host:port ("127.0.0.1:9222"), or http/ws URLs.
 */
export function normalizeLoopbackCdpEndpoint(endpoint: string): URL {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    throw new Error("CDP endpoint cannot be empty.");
  }

  let candidate: string;
  if (/^\d{1,5}$/.test(trimmed)) {
    candidate = `http://127.0.0.1:${trimmed}`;
  } else if (/^https?:\/\//i.test(trimmed) || /^wss?:\/\//i.test(trimmed)) {
    candidate = trimmed.replace(/^ws(s?):\/\//i, "http$1://");
  } else {
    candidate = `http://${trimmed}`;
  }

  const parsed = new URL(candidate);
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`CDP endpoint must be loopback-only (127.0.0.1, localhost, or ::1). Got "${parsed.hostname}".`);
  }
  return parsed;
}

export class CdpClient {
  public readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();

  constructor(wsUrl: string) {
    const parsed = new URL(wsUrl);
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new Error(`CDP WebSocket URL must be loopback-only. Got "${parsed.hostname}".`);
    }
    this.wsUrl = wsUrl;
  }

  static async findPages(endpoint: string): Promise<CdpTarget[]> {
    const base = normalizeLoopbackCdpEndpoint(endpoint);
    const url = new URL("/json", base);
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`CDP endpoint returned HTTP ${status}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(3000, () => {
        req.destroy(new Error("Timeout connecting to CDP endpoint"));
      });
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      entry.reject(err);
    }
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      let opened = false;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("CDP WebSocket connection timeout"));
      }, 5000);

      ws.on("open", () => {
        opened = true;
        clearTimeout(timeout);
        resolve();
      });

      ws.on("message", (data: string | Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) {
              reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              resolve(msg.result);
            }
          }
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on("close", () => {
        clearTimeout(timeout);
        const err = new Error("CDP WebSocket connection closed");
        if (!opened) {
          reject(err);
        } else {
          this.rejectAllPending(err);
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        const wrapped = err instanceof Error ? err : new Error(String(err));
        if (!opened) {
          reject(wrapped);
        } else {
          this.rejectAllPending(wrapped);
        }
      });
    });
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP client is not connected");
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command ${method} timed out`));
        }
      }, 15000);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = any>(expression: string): Promise<T> {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Evaluation failed: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value as T;
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.rejectAllPending(new Error("CDP client closed"));
  }
}
