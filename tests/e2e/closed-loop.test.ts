import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getOrCreateToken } from "../../packages/server/src/auth.ts";
import { createFigcpMcpServer } from "../../packages/server/src/mcp.ts";
import { TransportNode } from "../../packages/server/src/transport/node.ts";
import { FakeFigmaPlugin } from "../helpers/fake-plugin.ts";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr !== "object") {
        srv.close(() => reject(new Error("Failed to get ephemeral port")));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolvePort(port)));
    });
  });
}

describe("E2E Closed-Loop Pipeline 1", () => {
  it("runs inspect_design_system -> run_figma_js -> inspect_node_bounds (lint + PNG) -> figma_undo", async () => {
    const token = "fedcba9876543210fedcba9876543210";
    const transportNode = new TransportNode({ port: 0, token });
    await transportNode.start();

    let undoCalls = 0;
    const plugin = new FakeFigmaPlugin({
      port: transportNode.port,
      token,
      fileKey: "e2e-ds",
      fileName: "Persian DS",
      onCommand: (req) => {
        switch (req.method) {
          case "inspect_design_system":
            return {
              ok: true,
              result: {
                fileName: "Persian DS",
                currentPage: "Components",
                variableCollections: [
                  {
                    id: "col1",
                    name: "Colors-Semantic",
                    modes: [{ modeId: "m1", name: "Default" }],
                    variables: [{ id: "v1", name: "surface/card", resolvedType: "COLOR", valuesByMode: { m1: "#ffffff" } }],
                  },
                ],
                styles: { paint: [], text: [{ id: "ts1", name: "Desktop/Label" }], effect: [] },
                componentSets: [],
                fonts: [{ family: "IRANSansXFaNum", style: "Regular" }],
              },
              logs: [],
            };
          case "run_figma_js":
            return {
              ok: true,
              result: { id: "5031:9999", variants: 16 },
              logs: [{ level: "log", args: ["Search Box built"] }],
              durationMs: 25,
            };
          case "inspect_node_bounds":
            return {
              ok: true,
              result: {
                node: {
                  id: req.params.nodeId,
                  name: "Search Box",
                  type: "COMPONENT",
                  layoutMode: "HORIZONTAL",
                  itemSpacing: 8,
                  hasVisibleSolidFill: true,
                  boundVariables: { fills: [{ id: "v1" }], itemSpacing: { id: "v_gap" } },
                  absoluteBoundingBox: { x: 0, y: 0, width: 340, height: 44 },
                  children: [
                    {
                      id: "5031:10000",
                      name: "Query Text",
                      type: "TEXT",
                      characters: "جستجو در دوره‌ها...",
                      textAlignHorizontal: "RIGHT",
                      absoluteBoundingBox: { x: 12, y: 12, width: 280, height: 20 },
                    },
                  ],
                },
                screenshotBase64: "iVBORw==",
              },
              logs: [],
            };
          case "figma_undo":
            undoCalls++;
            return { ok: true, result: { ok: true, action: "undo" }, logs: [] };
          case "get_design_context":
            return {
              ok: true,
              result: {
                root: {
                  id: "5031:4449",
                  name: "Search Box",
                  type: "COMPONENT",
                  rect: { x: 0, y: 0, width: 340, height: 44 },
                  layoutMode: "HORIZONTAL",
                },
              },
              logs: [],
            };
          case "export_node_assets":
            return {
              ok: true,
              result: {
                ok: true,
                format: "SVG",
                content: "<svg><path d=\"\" /></svg>",
                nodeId: "5031:4449",
                nodeName: "SearchBox",
              },
              logs: [],
            };
          default:
            return { ok: false, error: { name: "Error", message: "Unexpected" }, logs: [] };
        }
      },
    });

    const mcpServer = createFigcpMcpServer(transportNode);
    const client = new Client({ name: "e2e-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await plugin.connect();
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);

      // 1. Discover DS
      const dsRes = await client.callTool({
        name: "inspect_design_system",
        arguments: { fontQuery: "IRANSans" },
      });
      const dsText = (dsRes.content as Array<{ text: string }>)[0]!.text;
      assert.ok(dsText.includes("IRANSansXFaNum"));

      // 2. Execute script
      const execRes = await client.callTool({
        name: "run_figma_js",
        arguments: { code: "return { id: '5031:9999', variants: 16 };" },
      });
      const execJson = JSON.parse((execRes.content as Array<{ text: string }>)[0]!.text);
      assert.equal(execJson.ok, true);
      assert.equal(execJson.result.variants, 16);

      // 3. Inspect bounds + lint + screenshot
      const inspectRes = await client.callTool({
        name: "inspect_node_bounds",
        arguments: { nodeId: "5031-9999", includeScreenshot: true },
      });
      const blocks = inspectRes.content as Array<{ type: string; text?: string; mimeType?: string }>;
      const inspectJson = JSON.parse(blocks[0]!.text!);
      assert.equal(inspectJson.node.id, "5031:9999");
      assert.deepEqual(inspectJson.lintIssues, []);
      assert.equal(blocks[1]?.type, "image");

      // 4. Undo
      await client.callTool({ name: "figma_undo", arguments: { action: "undo" } });
      assert.equal(undoCalls, 1);

      // 5. Bidirectional: Get design context (Figma -> Code)
      const ctxRes = await client.callTool({
        name: "get_design_context",
        arguments: { nodeId: "5031:4449" },
      });
      const ctxJson = JSON.parse((ctxRes.content as Array<{ text: string }>)[0]!.text);
      assert.equal(ctxJson.root.id, "5031:4449");

      // 6. Bidirectional: Export SVG asset
      const assetRes = await client.callTool({
        name: "export_node_assets",
        arguments: { nodeId: "5031:4449", format: "SVG" },
      });
      const assetSvg = (assetRes.content as Array<{ text: string }>)[0]!.text;
      assert.ok(assetSvg.includes("<svg>"));
    } finally {
      await client.close();
      await mcpServer.close();
      await plugin.disconnect();
      await transportNode.stop();
    }
  });

  it("spawns compiled stdio server (dist/index.js) and verifies plugin dist + compiled --setup", async () => {
    // Ensure compiled dist artifacts exist before testing bundled entrypoints
    const buildRes = spawnSync("npm", ["run", "build"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    assert.equal(buildRes.status, 0, `Build failed: ${buildRes.stderr}`);

    // 1. Verify plugin dist artifact completeness
    const pluginDist = join(ROOT_DIR, "packages", "plugin", "dist");
    const manifest = JSON.parse(readFileSync(join(pluginDist, "manifest.json"), "utf8")) as {
      main: string;
      ui: string;
    };
    assert.equal(existsSync(join(pluginDist, manifest.main)), true);
    assert.equal(existsSync(join(pluginDist, manifest.ui)), true);
    assert.equal(existsSync(join(pluginDist, "ui.template.html")), true);

    const codeJsContent = readFileSync(join(pluginDist, manifest.main), "utf8");
    assert.equal(codeJsContent.includes("ZodError"), false, "plugin bundle should not bundle zod");
    assert.ok(
      Buffer.byteLength(codeJsContent, "utf8") < 50_000,
      `plugin bundle code.js should be < 50 KB (was ${Buffer.byteLength(codeJsContent, "utf8")} bytes)`,
    );

    const serverDist = join(ROOT_DIR, "packages", "server", "dist", "index.js");
    assert.equal(existsSync(serverDist), true);

    const tempHome = mkdtempSync(join(tmpdir(), "figcp-e2e-stdio-"));
    const figcpHome = join(tempHome, ".figcp");
    mkdirSync(join(tempHome, ".cursor"), { recursive: true });

    try {
      // 2. Execute compiled dist/index.js --setup against isolated HOME
      const port = await getFreePort();
      const setupProc = spawnSync(process.execPath, [serverDist, "--setup"], {
        cwd: ROOT_DIR,
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          FIGCP_HOME: figcpHome,
          FIGCP_PORT: String(port),
        },
        encoding: "utf8",
      });
      assert.equal(setupProc.status, 0, `Compiled --setup failed: ${setupProc.stderr}`);
      assert.equal(existsSync(join(figcpHome, "plugin", "manifest.json")), true);
      assert.equal(existsSync(join(figcpHome, "plugin", "code.js")), true);
      assert.equal(existsSync(join(figcpHome, "plugin", "ui.html")), true);

      const cursorCfg = JSON.parse(readFileSync(join(tempHome, ".cursor", "mcp.json"), "utf8"));
      assert.equal(cursorCfg.mcpServers.figcp.type, "stdio");
      assert.equal(cursorCfg.mcpServers.figcp.args[0], serverDist);

      // 3. Spawn compiled MCP server over real stdio and connect FakeFigmaPlugin over WebSocket
      const token = getOrCreateToken(figcpHome);
      const stdioTransport = new StdioClientTransport({
        command: process.execPath,
        args: [serverDist],
        env: {
          ...process.env,
          HOME: tempHome,
          FIGCP_HOME: figcpHome,
          FIGCP_PORT: String(port),
        },
        stderr: "pipe",
      });

      const client = new Client({ name: "stdio-e2e-client", version: "0.1.0" });
      await client.connect(stdioTransport);

      // Give Leader a brief moment to be listening, then connect FakeFigmaPlugin
      const plugin = new FakeFigmaPlugin({
        port,
        token,
        fileKey: "stdio-e2e-file",
        fileName: "Stdio E2E",
        onCommand: (req) => {
          if (req.method === "run_figma_js") {
            return { ok: true, result: { spawned: true }, logs: [{ level: "log", args: ["ok"] }] };
          }
          return { ok: true, result: { pong: true }, logs: [] };
        },
      });

      try {
        await plugin.connect();
        const listed = await client.listTools();
        assert.ok(listed.tools.some((t) => t.name === "figma_status"));
        assert.ok(listed.tools.some((t) => t.name === "run_figma_js"));
        assert.ok(listed.tools.some((t) => t.name === "get_design_context"));
        assert.ok(listed.tools.some((t) => t.name === "export_node_assets"));

        const execRes = await client.callTool({
          name: "run_figma_js",
          arguments: { code: "return { spawned: true };" },
        });
        const parsed = JSON.parse((execRes.content as Array<{ text: string }>)[0]!.text);
        assert.equal(parsed.ok, true);
        assert.deepEqual(parsed.result, { spawned: true });
      } finally {
        await plugin.disconnect();
        await client.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
