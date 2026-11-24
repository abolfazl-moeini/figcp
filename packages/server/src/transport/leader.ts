import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type ConnectedFileInfo, HttpRpcBodySchema, type RpcResponse } from "@figcp/shared";
import { WebSocketServer } from "ws";
import { validateAuthToken } from "../auth.ts";
import { PluginBridge } from "./bridge.ts";

const MAX_WS_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024;
const HTTP_BODY_TIMEOUT_MS = 30_000;

class HttpPayloadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LeaderOptions {
  port: number;
  host?: string;
  token: string;
}

export class LeaderServer {
  readonly bridge = new PluginBridge();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private boundPort: number;
  private readonly host: string;
  private readonly token: string;

  constructor(options: LeaderOptions) {
    this.boundPort = options.port;
    this.host = options.host ?? "127.0.0.1";
    this.token = options.token;
  }

  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WS_PAYLOAD_BYTES,
    });
    wss.on("error", (err) => {
      process.stderr.write(`[figcp] WebSocketServer error: ${err.message}\n`);
    });

    server.on("upgrade", (req, socket, head) => {
      socket.on("error", () => {
        // Prevent unhandled socket errors during upgrade handshake
      });
      const url = new URL(req.url ?? "/", `http://${this.host}:${this.boundPort}`);
      if (url.pathname !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const providedToken = url.searchParams.get("token") ?? this.extractBearer(req);
      if (!validateAuthToken(providedToken, this.token)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        this.bridge.attachSocket(ws);
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.boundPort = addr.port;
        }
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.boundPort, this.host);
    });

    this.server = server;
    this.wss = wss;
  }

  async stop(): Promise<void> {
    this.bridge.closeAll();
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  private extractBearer(req: IncomingMessage): string | null {
    const auth = req.headers.authorization;
    if (!auth) return null;
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    return match?.[1] ?? null;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${this.host}:${this.boundPort}`);

    if (req.method === "GET" && url.pathname === "/ping") {
      this.sendJson(res, 200, { ok: true, service: "figcp", role: "leader" });
      return;
    }

    const providedToken = this.extractBearer(req);
    if (!validateAuthToken(providedToken, this.token)) {
      this.sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/files") {
      const files: ConnectedFileInfo[] = this.bridge.listConnectedFiles();
      this.sendJson(res, 200, { ok: true, files });
      return;
    }

    if (req.method === "POST" && url.pathname === "/rpc") {
      let parsedBody: unknown;
      try {
        parsedBody = await this.readJsonBody(req);
      } catch (err) {
        if (err instanceof HttpPayloadError) {
          this.sendJson(res, err.status, { ok: false, error: err.message });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.sendJson(res, 400, { ok: false, error: message });
        return;
      }

      const validated = HttpRpcBodySchema.safeParse(parsedBody);
      if (!validated.success) {
        this.sendJson(res, 400, {
          ok: false,
          error: `Invalid RPC body: ${validated.error.issues[0]?.message ?? "schema error"}`,
        });
        return;
      }

      try {
        const response: RpcResponse = await this.bridge.sendCommand(validated.data);
        this.sendJson(res, 200, { ok: true, response });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.sendJson(res, 502, { ok: false, error: message });
      }
      return;
    }

    this.sendJson(res, 404, { ok: false, error: "Not found" });
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy();
        reject(new HttpPayloadError(408, "Request body read timed out"));
      }, HTTP_BODY_TIMEOUT_MS);

      const finishError = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };

      req.on("data", (chunk: Buffer | string) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        totalBytes += buf.length;
        if (totalBytes > MAX_HTTP_BODY_BYTES) {
          req.destroy();
          finishError(new HttpPayloadError(413, `Request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`));
          return;
        }
        chunks.push(buf);
      });

      req.on("end", () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new HttpPayloadError(400, "Invalid JSON body"));
        }
      });

      req.on("error", (err) => {
        finishError(err);
      });
    });
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}
