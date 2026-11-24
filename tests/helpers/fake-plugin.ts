import type { RpcRequest, RpcResponse } from "@figcp/shared";
import WebSocket from "ws";

export interface FakePluginOptions {
  port: number;
  token: string;
  fileKey: string;
  fileName: string;
  pageName?: string;
  onCommand?: (req: RpcRequest) => Promise<Omit<RpcResponse, "type" | "id">> | Omit<RpcResponse, "type" | "id">;
}

export class FakeFigmaPlugin {
  private ws: WebSocket | null = null;
  private readonly options: FakePluginOptions;

  constructor(options: FakePluginOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const url = `ws://127.0.0.1:${this.options.port}/ws?token=${encodeURIComponent(this.options.token)}`;
    const ws = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            fileKey: this.options.fileKey,
            fileName: this.options.fileName,
            pageName: this.options.pageName ?? "Page 1",
            pluginVersion: "0.1.0",
          }),
        );
        resolve();
      });
      ws.once("error", (err) => reject(err));
    });

    ws.on("message", async (raw) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(raw.toString("utf8")) as RpcRequest;
      } catch {
        return;
      }
      if (req.type !== "rpc_request") return;

      if (this.options.onCommand) {
        const partial = await this.options.onCommand(req);
        ws.send(JSON.stringify({ type: "rpc_response", id: req.id, ...partial }));
        return;
      }

      ws.send(
        JSON.stringify({
          type: "rpc_response",
          id: req.id,
          ok: true,
          result: { pong: true, fileKey: this.options.fileKey, fileName: this.options.fileName },
          logs: [],
        }),
      );
    });

    this.ws = ws;
    // Allow leader a tick to register hello
    await new Promise((r) => setTimeout(r, 25));
  }

  async disconnect(): Promise<void> {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    await new Promise<void>((resolve) => {
      if (ws.readyState === ws.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });
    await new Promise((r) => setTimeout(r, 25));
  }
}
