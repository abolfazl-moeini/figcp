import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebCaptureResultSchema, type WebCaptureResult } from "@figcp/shared";
import {
  CdpClient,
  normalizeLoopbackCdpEndpoint,
} from "../web-capture/cdp-client.ts";
import { WebCaptureManager } from "../web-capture/capture-manager.ts";
import { generateFigmaImportScript } from "../web-capture/figma-builder.ts";
import { createFigcpMcpServer } from "../mcp.ts";
import { TransportNode } from "../transport/node.ts";
import { FakeFigmaPlugin } from "../../../../tests/helpers/fake-plugin.ts";

describe("Web Capture & Figma Tree Generation", () => {
  const sampleCapture: WebCaptureResult = {
    url: "https://example.com",
    title: "Example Domain",
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    variables: {
      "--primary-color": "#3b82f6",
      "--padding-base": "16px",
    },
    breakpoints: [{ query: "min-width 768px", px: 768, count: 2 }],
    fonts: [{ family: "IRANSansXFaNum", weight: "400", status: "loaded" }],
    tree: {
      id: "web-node-1",
      tagName: "BODY",
      name: "Page Body",
      rect: { x: 0, y: 0, width: 1440, height: 900 },
      styles: {
        display: "flex",
        layoutMode: "VERTICAL",
        padding: { top: 20, right: 20, bottom: 20, left: 20 },
        itemSpacing: 16,
        backgroundColor: "#ffffff",
      },
      children: [
        {
          id: "web-node-2",
          tagName: "H1",
          name: "Hero Title",
          rect: { x: 20, y: 20, width: 400, height: 40 },
          styles: {
            fontSize: 24,
            fontFamily: "IRANSansXFaNum",
            color: "#0f172a",
          },
          text: "به سامانه خوش آمدید",
          direction: "rtl",
        },
        {
          id: "web-node-3",
          tagName: "IMG",
          name: "Hero Image",
          rect: { x: 20, y: 80, width: 200, height: 120 },
          styles: {},
          imageUrl: "https://example.com/hero.png",
        },
      ],
    },
    states: [
      {
        index: 0,
        kind: "menu",
        label: "Open Menu",
        changed: ["expanded"],
      },
    ],
  };

  it("validates WebCaptureResult schema", () => {
    const parse = WebCaptureResultSchema.safeParse(sampleCapture);
    assert.equal(parse.success, true);
  });

  it("generates executable Figma script using real helpers and APIs", () => {
    const script = generateFigmaImportScript(sampleCapture);
    assert.match(script, /helpers\.loadFontSafe/);
    assert.match(script, /helpers\.getOrCreateVariable/);
    assert.doesNotMatch(script, /createColorVariableSafe|createFloatVariableSafe/);
    assert.match(script, /helpers\.resizeFrameSafe/);
    assert.match(script, /helpers\.setAutoLayout/);
    assert.match(script, /figma\.createImageAsync/);
    assert.match(script, /figma\.combineAsVariants/);
  });

  it("enforces loopback-only CDP endpoints and normalizes ports", () => {
    assert.equal(normalizeLoopbackCdpEndpoint("9222").href, "http://127.0.0.1:9222/");
    assert.equal(normalizeLoopbackCdpEndpoint("localhost:9222").href, "http://localhost:9222/");
    assert.equal(normalizeLoopbackCdpEndpoint("http://[::1]:9222").href, "http://[::1]:9222/");

    assert.throws(() => normalizeLoopbackCdpEndpoint("http://evil.com:9222"), /loopback-only/);
    assert.throws(() => new CdpClient("ws://evil.com:9222/devtools/page/1"), /loopback-only/);
  });

  it("captures page via mock CDP server and runs import_web_to_figma with post-import lint check", async () => {
    let wss: WebSocketServer | undefined;
    const server = http.createServer((req, res) => {
      if (req.url === "/json") {
        const addr = server.address() as { port: number };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: "page-1",
              title: "Mock Page",
              type: "page",
              url: "https://example.com/dashboard",
              webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/page-1`,
            },
          ]),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const cdpPort = (server.address() as { port: number }).port;
    wss = new WebSocketServer({ server });

    const methodsCalled: string[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { id: number; method: string; params?: { expression?: string } };
        methodsCalled.push(msg.method);
        if (msg.method === "Runtime.evaluate") {
          const expr = msg.params?.expression || "";
          if (expr.includes("window.scrollTo")) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: true } } }));
          } else if (expr.includes("extractTree")) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: sampleCapture } } }));
          } else if (expr.includes("data-figcp-state") && expr.includes("querySelectorAll")) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: [{ index: 0, kind: "menu", label: "Menu" }] } } }));
          } else if (expr.includes("dialogs")) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { present: true, expanded: "false", selected: null, open: null, dialogs: 0, url: "https://example.com" } } } }));
          } else {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: true } } }));
          }
          return;
        }
        if (msg.method === "Page.captureScreenshot") {
          ws.send(JSON.stringify({ id: msg.id, result: { data: "AAAA" } }));
          return;
        }
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      });
    });

    const transportNode = new TransportNode({ port: 0, token: "a".repeat(32) });
    await transportNode.start();
    const pluginMethods: string[] = [];
    const plugin = new FakeFigmaPlugin({
      port: transportNode.port,
      token: "a".repeat(32),
      fileKey: "web-file",
      fileName: "Web Import File",
      onCommand: (req) => {
        pluginMethods.push(req.method);
        if (req.method === "run_figma_js") {
          return { ok: true, result: { success: true, rootId: "50:1", name: "Web Import" }, logs: [] };
        }
        if (req.method === "inspect_node_bounds") {
          return {
            ok: true,
            result: {
              node: {
                id: "50:1",
                name: "Web Import",
                type: "FRAME",
                visible: true,
                absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
              },
              truncated: false,
            },
            logs: [],
          };
        }
        return { ok: true, result: {}, logs: [] };
      },
    });

    const mcpServer = createFigcpMcpServer(transportNode);
    const client = new Client({ name: "web-capture-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      const captured = await WebCaptureManager.captureWeb({
        cdpEndpoint: `127.0.0.1:${cdpPort}`,
        captureStates: true,
      });
      assert.equal(captured.title, "Example Domain");
      assert.equal(captured.states?.length, 1);
      assert.ok(methodsCalled.includes("Emulation.setDeviceMetricsOverride"));
      assert.ok(methodsCalled.includes("Emulation.setEmulatedMedia"));

      await plugin.connect();
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);

      const res = await client.callTool({
        name: "import_web_to_figma",
        arguments: { cdpEndpoint: `127.0.0.1:${cdpPort}` },
      });
      assert.equal(res.isError ?? false, false);
      const text = (res.content as Array<{ text: string }>)[0]!.text;
      const parsed = JSON.parse(text);
      assert.equal(parsed.success, true);
      assert.equal(parsed.result.rootId, "50:1");
      assert.deepEqual(parsed.lintIssues, []);
      assert.deepEqual(pluginMethods, ["run_figma_js", "inspect_node_bounds"]);
    } finally {
      await client.close();
      await mcpServer.close();
      await plugin.disconnect();
      await transportNode.stop();
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
