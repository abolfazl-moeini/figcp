import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FakeFigmaPlugin } from "../../../../tests/helpers/fake-plugin.ts";
import { createFigcpMcpServer, spillLargePayload } from "../mcp.ts";
import { TransportNode } from "../transport/node.ts";

const TEST_TOKEN = "99998888777766665555444433332222";

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("MCP 7-tool server", () => {
  it("contains zero console.log calls in packages/server/src (stdout hygiene)", () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    for (const file of walkTsFiles(srcRoot)) {
      const text = readFileSync(file, "utf8");
      assert.equal(text.includes("console.log("), false, `Found forbidden console.log in ${file}`);
    }
  });

  it("exposes all 7 tools and returns native MCP image content + lintIssues", async () => {
    const transportNode = new TransportNode({ port: 0, token: TEST_TOKEN });
    await transportNode.start();

    const plugin = new FakeFigmaPlugin({
      port: transportNode.port,
      token: TEST_TOKEN,
      fileKey: "ds-file",
      fileName: "Main DS",
      onCommand: (req) => {
        if (req.method === "run_figma_js") {
          return {
            ok: true,
            result: { id: "100:1" },
            logs: [{ level: "log", args: ["created Search Box"] }],
            durationMs: 12,
          };
        }
        if (req.method === "inspect_design_system") {
          return {
            ok: true,
            result: {
              fileName: "Main DS",
              currentPage: "Components",
              variableCollections: [],
              styles: { paint: [], text: [], effect: [] },
              componentSets: [],
              fonts: [{ family: "IRANSansXFaNum", style: "Regular" }],
            },
            logs: [],
          };
        }
        if (req.method === "inspect_node_bounds") {
          return {
            ok: true,
            result: {
              node: {
                id: req.params.nodeId ?? "100:1",
                name: "BadText",
                type: "TEXT",
                characters: "سلام دنیا",
                textAlignHorizontal: "LEFT",
              },
              screenshotBase64: "iVBORw==",
            },
            logs: [],
          };
        }
        if (req.method === "figma_undo") {
          return { ok: true, result: { ok: true, action: "undo" }, logs: [] };
        }
        if (req.method === "figma_status") {
          return {
            ok: true,
            result: { fileKey: "ds-file", changeSeq: 0, manualChanges: [] },
            logs: [],
          };
        }
        if (req.method === "get_design_context") {
          return {
            ok: true,
            result: {
              root: {
                id: "100:1",
                name: "Search Box",
                type: "COMPONENT",
                rect: { x: 0, y: 0, width: 340, height: 44 },
                layoutMode: "HORIZONTAL",
                component: { id: "comp-1", name: "SearchBox" },
              },
            },
            logs: [],
          };
        }
        if (req.method === "export_node_assets") {
          return {
            ok: true,
            result: {
              ok: true,
              format: req.params.format ?? "SVG",
              content: "<svg></svg>",
              nodeId: "100:1",
              nodeName: "SearchIcon",
            },
            logs: [],
          };
        }
        return { ok: false, error: { name: "Error", message: "Unknown" }, logs: [] };
      },
    });

    const mcpServer = createFigcpMcpServer(transportNode);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await plugin.connect();
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "export_node_assets",
        "figma_status",
        "figma_undo",
        "get_design_context",
        "inspect_design_system",
        "inspect_node_bounds",
        "run_figma_js",
      ]);

      const dtcgRes = await client.callTool({
        name: "inspect_design_system",
        arguments: { format: "dtcg" },
      });
      assert.equal(dtcgRes.isError ?? false, false);

      const ctxRes = await client.callTool({
        name: "get_design_context",
        arguments: { nodeId: "100:1" },
      });
      assert.equal(ctxRes.isError ?? false, false);
      const ctxText = (ctxRes.content as Array<{ text: string }>)[0]!.text;
      assert.ok(ctxText.includes("SearchBox"));

      const assetRes = await client.callTool({
        name: "export_node_assets",
        arguments: { nodeId: "100:1", format: "SVG" },
      });
      assert.equal(assetRes.isError ?? false, false);

      const statusRes = await client.callTool({ name: "figma_status", arguments: {} });
      assert.equal(statusRes.isError ?? false, false);
      const statusText = (statusRes.content as Array<{ text: string }>)[0]!.text;
      assert.ok(statusText.includes("connectedFiles"));
      assert.ok(statusText.includes("ds-file"));

      // Connect second plugin and verify figma_status lists both without disambiguation error
      const plugin2 = new FakeFigmaPlugin({
        port: transportNode.port,
        token: TEST_TOKEN,
        fileKey: "screen-file",
        fileName: "Checkout Screen",
      });
      await plugin2.connect();
      try {
        const multiStatusRes = await client.callTool({ name: "figma_status", arguments: {} });
        assert.equal(multiStatusRes.isError ?? false, false);
        const multiText = (multiStatusRes.content as Array<{ text: string }>)[0]!.text;
        assert.ok(multiText.includes("ds-file"));
        assert.ok(multiText.includes("screen-file"));
        assert.ok(multiText.includes("Multiple Figma documents connected"));
      } finally {
        await plugin2.disconnect();
      }

      const runRes = await client.callTool({
        name: "run_figma_js",
        arguments: { code: "return { id: '100:1' };" },
      });
      assert.equal(runRes.isError ?? false, false);

      const boundsRes = await client.callTool({
        name: "inspect_node_bounds",
        arguments: { nodeId: "100-1", includeScreenshot: true },
      });
      const blocks = boundsRes.content as Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
      assert.equal(blocks.length, 2);
      assert.equal(blocks[0]?.type, "text");
      const parsedBounds = JSON.parse(blocks[0]!.text!);
      assert.equal(parsedBounds.node.id, "100:1");
      assert.equal(parsedBounds.lintIssues[0]?.rule, "rtl-alignment-mismatch");
      assert.equal(blocks[1]?.type, "image");
      assert.equal(blocks[1]?.mimeType, "image/png");
      assert.equal(blocks[1]?.data, "iVBORw==");

      const undoRes = await client.callTool({ name: "figma_undo", arguments: { action: "undo" } });
      assert.equal(undoRes.isError ?? false, false);
    } finally {
      await client.close();
      await mcpServer.close();
      await plugin.disconnect();
      await transportNode.stop();
    }
  });

  it("returns ValidationError when plugin returns malformed inspect_node_bounds payload", async () => {
    const transportNode = new TransportNode({ port: 0, token: TEST_TOKEN });
    await transportNode.start();

    const plugin = new FakeFigmaPlugin({
      port: transportNode.port,
      token: TEST_TOKEN,
      fileKey: "bad-payload",
      fileName: "Bad Payload",
      onCommand: () => ({
        ok: true,
        result: { unexpected: true },
        logs: [],
      }),
    });

    const mcpServer = createFigcpMcpServer(transportNode);
    const client = new Client({ name: "test-client-err", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await plugin.connect();
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);

      const res = await client.callTool({
        name: "inspect_node_bounds",
        arguments: { nodeId: "1:1" },
      });
      assert.equal(res.isError, true);
      const text = (res.content as Array<{ text: string }>)[0]!.text;
      assert.match(text, /ValidationError/);
    } finally {
      await client.close();
      await mcpServer.close();
      await plugin.disconnect();
      await transportNode.stop();
    }
  });

  it("spills payloads > 64 KB to disk with compact summary and preserves full file", () => {
    const hugePayload = {
      items: Array.from({ length: 2000 }, (_, i) => ({ id: `node-${i}`, data: "x".repeat(50) })),
    };
    const spilled = spillLargePayload("test_tool", hugePayload, 1024);
    assert.ok(spilled.fullOutputPath);
    const parsed = JSON.parse(spilled.text);
    assert.equal(parsed.spilled, true);
    assert.equal(parsed.tool, "test_tool");
    assert.ok(parsed.byteLength > 1024);
  });
});
