import { randomUUID } from "node:crypto";
import {
  type ConnectedFileInfo,
  PluginHelloMessageSchema,
  type RpcMethod,
  type RpcRequest,
  type RpcResponse,
  RpcResponseSchema,
} from "@figcp/shared";
import type { WebSocket } from "ws";

interface PendingRequest {
  resolve: (res: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  fileKey: string;
  ws: WebSocket;
}

interface PluginConnection {
  ws: WebSocket;
  info: ConnectedFileInfo;
  isAlive: boolean;
}

export interface PluginBridgeOptions {
  heartbeatIntervalMs?: number;
}

export class PluginBridge {
  private readonly connections = new Map<string, PluginConnection>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly connectionWaiters = new Set<() => void>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatIntervalMs: number;

  constructor(options: PluginBridgeOptions = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer || this.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [fileKey, conn] of this.connections.entries()) {
        if (!conn.isAlive) {
          this.connections.delete(fileKey);
          this.rejectPendingForSocket(conn.ws, `Figma plugin heartbeat timed out for file "${fileKey}"`);
          try {
            conn.ws.terminate();
          } catch {
            // Ignore terminate errors
          }
          continue;
        }
        conn.isAlive = false;
        try {
          if (conn.ws.readyState === conn.ws.OPEN) {
            conn.ws.ping();
          }
        } catch {
          // Ignore ping errors; close/error will clean up
        }
      }
      if (this.connections.size === 0 && this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  attachSocket(ws: WebSocket): void {
    let boundFileKey: string | null = null;

    const cleanupSocket = (reason: string) => {
      this.rejectPendingForSocket(ws, reason);
      if (boundFileKey) {
        const current = this.connections.get(boundFileKey);
        if (current && current.ws === ws) {
          this.connections.delete(boundFileKey);
        }
      }
      for (const [key, entry] of this.connections.entries()) {
        if (entry.ws === ws) {
          this.connections.delete(key);
        }
      }
    };

    ws.on("pong", () => {
      if (!boundFileKey) return;
      const conn = this.connections.get(boundFileKey);
      if (conn && conn.ws === ws) {
        conn.isAlive = true;
      }
    });

    ws.on("error", (err) => {
      cleanupSocket(`WebSocket error on plugin connection: ${err.message}`);
    });

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
        return;
      }

      const msgType = (parsed as { type: unknown }).type;
      if (msgType === "hello") {
        const res = PluginHelloMessageSchema.safeParse(parsed);
        if (!res.success) return;

        const { fileKey, fileName, pageName, pluginVersion } = res.data;

        // If this socket previously registered a different fileKey, clean up the old binding.
        if (boundFileKey && boundFileKey !== fileKey) {
          const prev = this.connections.get(boundFileKey);
          if (prev && prev.ws === ws) {
            this.connections.delete(boundFileKey);
          }
          this.rejectPendingForSocket(ws, `Plugin switched active fileKey from "${boundFileKey}" to "${fileKey}"`);
        }
        boundFileKey = fileKey;

        const existing = this.connections.get(fileKey);
        if (existing && existing.ws !== ws) {
          this.rejectPendingForSocket(existing.ws, `Plugin connection for "${fileKey}" was replaced`);
          try {
            existing.ws.close(1000, "Replaced by newer plugin connection");
          } catch {
            // Ignore close errors
          }
        }

        this.connections.set(fileKey, {
          ws,
          isAlive: true,
          info: {
            fileKey,
            fileName,
            pageName,
            pluginVersion,
            connectedAt: Date.now(),
          },
        });
        this.ensureHeartbeat();
        for (const notify of this.connectionWaiters) {
          notify();
        }
        return;
      }

      if (msgType === "rpc_response") {
        const res = RpcResponseSchema.safeParse(parsed);
        if (!res.success) {
          const rawId = (parsed as { id?: unknown }).id;
          if (typeof rawId === "string") {
            const pending = this.pending.get(rawId);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(rawId);
              pending.reject(
                new Error(`Invalid rpc_response from plugin: ${res.error.issues[0]?.message ?? "schema mismatch"}`),
              );
            }
          }
          return;
        }

        const pending = this.pending.get(res.data.id);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pending.delete(res.data.id);
        pending.resolve(res.data);
      }
    });

    ws.on("close", () => {
      cleanupSocket(
        boundFileKey
          ? `Figma plugin disconnected for file "${boundFileKey}"`
          : "Figma plugin disconnected",
      );
    });
  }

  async waitForConnection(fileKey: string | undefined, timeoutMs: number): Promise<boolean> {
    if (fileKey ? this.connections.has(fileKey) : this.connections.size > 0) {
      return true;
    }
    if (timeoutMs <= 0) return false;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.connectionWaiters.delete(onConnect);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();

      const onConnect = () => {
        if (fileKey ? this.connections.has(fileKey) : this.connections.size > 0) {
          clearTimeout(timer);
          this.connectionWaiters.delete(onConnect);
          resolve(true);
        }
      };
      this.connectionWaiters.add(onConnect);
    });
  }

  listConnectedFiles(): ConnectedFileInfo[] {
    return Array.from(this.connections.values()).map((entry) => entry.info);
  }

  resolveTargetFileKey(fileKey?: string): string {
    if (fileKey) {
      if (!this.connections.has(fileKey)) {
        const available = this.listConnectedFiles()
          .map((f) => `${f.fileName} (${f.fileKey})`)
          .join(", ");
        throw new Error(
          `Figma file "${fileKey}" is not connected. Connected files: ${available || "none"}`,
        );
      }
      return fileKey;
    }

    const keys = Array.from(this.connections.keys());
    if (keys.length === 0) {
      throw new Error(
        "No Figma plugin is connected. Open your file in Figma Desktop and run Plugins → Development → figcp.",
      );
    }
    if (keys.length > 1) {
      const list = this.listConnectedFiles()
        .map((f) => `${f.fileName} (fileKey="${f.fileKey}")`)
        .join(", ");
      throw new Error(
        `Multiple Figma files are connected (${list}). Specify "fileKey" to target a specific file.`,
      );
    }
    return keys[0]!;
  }

  async sendCommand(options: {
    method: RpcMethod;
    params?: Record<string, unknown>;
    fileKey?: string;
    timeoutMs?: number;
  }): Promise<RpcResponse> {
    const targetKey = this.resolveTargetFileKey(options.fileKey);
    const conn = this.connections.get(targetKey);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) {
      throw new Error(`WebSocket for file "${targetKey}" is not open.`);
    }

    const timeoutMs = options.timeoutMs ?? 30_000;
    const id = randomUUID();
    const request: RpcRequest = {
      type: "rpc_request",
      id,
      method: options.method,
      params: options.params ?? {},
      timeoutMs,
    };

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC "${options.method}" timed out after ${timeoutMs}ms on file "${targetKey}".`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, fileKey: targetKey, ws: conn.ws });

      try {
        conn.ws.send(JSON.stringify(request), (err) => {
          if (err && this.pending.has(id)) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  closeAll(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const notify of this.connectionWaiters) {
      notify();
    }
    this.connectionWaiters.clear();

    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge shutting down"));
      this.pending.delete(id);
    }
    for (const conn of this.connections.values()) {
      try {
        conn.ws.close(1000, "Server shutting down");
      } catch {
        // Ignore close errors
      }
    }
    this.connections.clear();
  }

  private rejectPendingForSocket(ws: WebSocket, reason: string): void {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.ws === ws) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
        this.pending.delete(id);
      }
    }
  }
}
