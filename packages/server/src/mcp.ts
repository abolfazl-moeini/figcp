import { lintNodeTree } from "@figcp/linter";
import {
  DesignSystemSnapshotSchema,
  InspectNodeBoundsResultSchema,
  normalizeNodeId,
} from "@figcp/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TransportNode } from "./transport/node.ts";

export function createFigcpMcpServer(transport: TransportNode): McpServer {
  const server = new McpServer({
    name: "figcp",
    version: "0.1.0",
  });

  server.tool(
    "run_figma_js",
    "Execute arbitrary Figma Plugin API JavaScript inside the connected Figma Desktop file. Globals `figma` and `helpers` are in scope. Runs in a serial queue, captures console logs and stack traces, and checkpoints undo by default (pass commitUndo=false for read-only scripts).",
    {
      code: z.string().min(1).describe("Async JavaScript body with `figma` and `helpers` in scope. Return JSON-serializable data."),
      fileKey: z.string().optional().describe("Target Figma fileKey (required only when multiple Figma files are connected)."),
      timeoutMs: z.number().int().positive().max(180_000).optional().describe("Execution timeout in ms (default 30000, max 180000)."),
      commitUndo: z.boolean().optional().describe("Call figma.commitUndo() on mutation (default true; pass false for read-only inspections)."),
    },
    async ({ code, fileKey, timeoutMs, commitUndo }) => {
      const response = await transport.sendCommand({
        method: "run_figma_js",
        params: { code, commitUndo: commitUndo ?? true },
        fileKey,
        timeoutMs: timeoutMs ?? 30_000,
      });

      const payload = response.ok
        ? {
            ok: true,
            result: response.result,
            logs: response.logs,
            durationMs: response.durationMs,
          }
        : {
            ok: false,
            error: response.error,
            logs: response.logs,
            durationMs: response.durationMs,
          };

      return {
        isError: !response.ok,
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  server.tool(
    "inspect_design_system",
    "Read the open Figma file's Local Variable Collections (with resolved alias names), Paint/Text/Effect Styles, Component Sets (variant counts & properties), and optionally filter installed local fonts (e.g. fontQuery='IRANSans').",
    {
      fileKey: z.string().optional().describe("Target Figma fileKey when multiple files are connected."),
      fontQuery: z.string().optional().describe("Case-insensitive substring to filter available local fonts (e.g. 'IRANSans')."),
      pageQuery: z.string().optional().describe("Optional case-insensitive substring to filter pages scanned for Component Sets."),
      maxPages: z.number().int().positive().max(200).optional().describe("Maximum number of pages to load/scan (default 50)."),
    },
    async ({ fileKey, fontQuery, pageQuery, maxPages }) => {
      const response = await transport.sendCommand({
        method: "inspect_design_system",
        params: {
          ...(fontQuery ? { fontQuery } : {}),
          ...(pageQuery ? { pageQuery } : {}),
          ...(maxPages !== undefined ? { maxPages } : {}),
        },
        fileKey,
      });

      if (!response.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(response.error, null, 2) }],
        };
      }

      const parsed = DesignSystemSnapshotSchema.safeParse(response.result);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: "ValidationError",
                  message: `Invalid inspect_design_system payload: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(parsed.data, null, 2) }],
      };
    },
  );

  server.tool(
    "inspect_node_bounds",
    "Inspect a node subtree's geometry (absoluteBoundingBox, absoluteRenderBounds), Auto Layout, bound variables, deterministic DS/RTL lint issues (overflow, overlap, unbound fills/spacing, RTL alignment), and optionally capture a PNG screenshot.",
    {
      nodeId: z.string().optional().describe("Target node ID ('5031:4449' or '5031-4449'). Defaults to current selection."),
      fileKey: z.string().optional().describe("Target Figma fileKey when multiple files are connected."),
      maxDepth: z.number().int().min(0).max(10).optional().describe("Maximum subtree traversal depth (default 4)."),
      includeScreenshot: z.boolean().optional().describe("Export PNG screenshot of the node and return it inline as an MCP image."),
      screenshotScale: z.number().min(0.5).max(4).optional().describe("PNG export scale factor (default 2)."),
    },
    async ({ nodeId, fileKey, maxDepth, includeScreenshot, screenshotScale }) => {
      const normalized = nodeId ? normalizeNodeId(nodeId) : undefined;
      const response = await transport.sendCommand({
        method: "inspect_node_bounds",
        params: {
          ...(normalized ? { nodeId: normalized } : {}),
          ...(maxDepth !== undefined ? { maxDepth } : {}),
          ...(includeScreenshot !== undefined ? { includeScreenshot } : {}),
          ...(screenshotScale !== undefined ? { screenshotScale } : {}),
        },
        fileKey,
      });

      if (!response.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(response.error, null, 2) }],
        };
      }

      const parsed = InspectNodeBoundsResultSchema.safeParse(response.result);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: "ValidationError",
                  message: `Invalid inspect_node_bounds payload: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const data = parsed.data;
      const lintIssues = lintNodeTree(data.node);

      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text",
          text: JSON.stringify({ node: data.node, lintIssues }, null, 2),
        },
      ];

      if (data.screenshotBase64) {
        content.push({
          type: "image",
          data: data.screenshotBase64,
          mimeType: "image/png",
        });
      }

      return { content };
    },
  );

  server.tool(
    "figma_undo",
    "Revert the last checkpointed run_figma_js mutation (action='undo') or save a named Figma version history restore point (action='snapshot').",
    {
      action: z.enum(["undo", "snapshot"]).optional().describe("'undo' (default) or 'snapshot'."),
      title: z.string().optional().describe("Snapshot title when action='snapshot'."),
      fileKey: z.string().optional().describe("Target Figma fileKey when multiple files are connected."),
    },
    async ({ action, title, fileKey }) => {
      const response = await transport.sendCommand({
        method: "figma_undo",
        params: { action: action ?? "undo", ...(title ? { title } : {}) },
        fileKey,
      });

      if (!response.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(response.error, null, 2) }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(response.result, null, 2) }],
      };
    },
  );

  return server;
}
