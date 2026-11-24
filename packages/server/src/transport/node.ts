import type { ConnectedFileInfo, RpcMethod, RpcResponse } from "@figcp/shared";
import { FollowerClient } from "./follower.ts";
import { LeaderServer } from "./leader.ts";

export interface TransportNodeOptions {
  port?: number;
  host?: string;
  token: string;
  takeoverReconnectWaitMs?: number;
}

export class TransportNode {
  private leader: LeaderServer | null = null;
  private follower: FollowerClient | null = null;
  private activePort: number;
  private readonly host: string;
  private readonly token: string;
  private readonly takeoverReconnectWaitMs: number;

  constructor(options: TransportNodeOptions) {
    this.activePort = options.port ?? Number(process.env.FIGCP_PORT ?? 1994);
    this.host = options.host ?? "127.0.0.1";
    this.token = options.token;
    this.takeoverReconnectWaitMs = options.takeoverReconnectWaitMs ?? 1500;
  }

  get role(): "leader" | "follower" | "stopped" {
    if (this.leader) return "leader";
    if (this.follower) return "follower";
    return "stopped";
  }

  get port(): number {
    return this.leader ? this.leader.port : this.activePort;
  }

  async start(): Promise<void> {
    const candidate = new LeaderServer({
      port: this.activePort,
      host: this.host,
      token: this.token,
    });

    try {
      await candidate.start();
      this.leader = candidate;
      this.follower = null;
      this.activePort = candidate.port;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") {
        throw err;
      }
      const follower = new FollowerClient({
        port: this.activePort,
        host: this.host,
        token: this.token,
      });
      const alive = await follower.ping();
      if (!alive) {
        throw new Error(`Port ${this.activePort} is occupied by another non-figcp process.`);
      }
      this.follower = follower;
      this.leader = null;
    }
  }

  async listConnectedFiles(): Promise<ConnectedFileInfo[]> {
    if (this.leader) {
      return this.leader.bridge.listConnectedFiles();
    }
    if (this.follower) {
      try {
        return await this.follower.listConnectedFiles();
      } catch (err) {
        const promoted = await this.attemptTakeover();
        if (promoted) {
          return promoted.bridge.listConnectedFiles();
        }
        if (await this.follower.ping()) {
          return await this.follower.listConnectedFiles();
        }
        throw err;
      }
    }
    throw new Error("TransportNode is not started.");
  }

  async sendCommand(options: {
    method: RpcMethod;
    params?: Record<string, unknown>;
    fileKey?: string;
    timeoutMs?: number;
  }): Promise<RpcResponse> {
    if (this.leader) {
      return this.leader.bridge.sendCommand(options);
    }
    if (this.follower) {
      const alive = await this.follower.ping();
      if (!alive) {
        const promoted = await this.attemptTakeover();
        if (promoted) {
          if (promoted.bridge.listConnectedFiles().length === 0 && this.takeoverReconnectWaitMs > 0) {
            await promoted.bridge.waitForConnection(options.fileKey, this.takeoverReconnectWaitMs);
          }
          return promoted.bridge.sendCommand(options);
        }
      }
      return this.follower.sendCommand(options);
    }
    throw new Error("TransportNode is not started.");
  }

  async stop(): Promise<void> {
    if (this.leader) {
      await this.leader.stop();
      this.leader = null;
    }
    this.follower = null;
  }

  private async attemptTakeover(): Promise<LeaderServer | null> {
    const candidate = new LeaderServer({
      port: this.activePort,
      host: this.host,
      token: this.token,
    });
    try {
      await candidate.start();
      this.leader = candidate;
      this.follower = null;
      return candidate;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") {
        throw err;
      }
      return null;
    }
  }
}
