import {
  type ConnectedFileInfo,
  FollowerFilesResponseSchema,
  FollowerRpcResponseSchema,
  PingResponseSchema,
  type RpcMethod,
  type RpcResponse,
} from "@figcp/shared";

export interface FollowerOptions {
  port: number;
  host?: string;
  token: string;
}

export class FollowerClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: FollowerOptions) {
    const host = options.host ?? "127.0.0.1";
    this.baseUrl = `http://${host}:${options.port}`;
    this.token = options.token;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/ping`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return false;
      const body = await res.json();
      return PingResponseSchema.safeParse(body).success;
    } catch {
      return false;
    }
  }

  async listConnectedFiles(): Promise<ConnectedFileInfo[]> {
    const res = await fetch(`${this.baseUrl}/files`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`Leader /files returned HTTP ${res.status}`);
    }
    const raw = await res.json();
    const parsed = FollowerFilesResponseSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.ok) {
      throw new Error(parsed.success ? parsed.data.error ?? "Failed to list connected files" : "Invalid /files response from Leader");
    }
    return parsed.data.files ?? [];
  }

  async sendCommand(options: {
    method: RpcMethod;
    params?: Record<string, unknown>;
    fileKey?: string;
    timeoutMs?: number;
  }): Promise<RpcResponse> {
    const timeoutMs = (options.timeoutMs ?? 30_000) + 2_000;
    const res = await fetch(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`Leader /rpc returned non-JSON HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const parsed = FollowerRpcResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Leader /rpc returned invalid response payload (HTTP ${res.status})`);
    }
    if (!res.ok || !parsed.data.ok || !parsed.data.response) {
      throw new Error(parsed.data.error ?? `Leader /rpc failed with HTTP ${res.status}`);
    }
    return parsed.data.response;
  }
}
