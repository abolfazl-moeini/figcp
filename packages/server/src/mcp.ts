import { lintNodeTree } from "@figcp/linter";
import {
  DesignSystemSnapshotSchema,
  ExportNodeAssetsResultSchema,
  GetDesignContextResultSchema,
  InspectNodeBoundsResultSchema,
  normalizeNodeId,
  toDtcgTokens,
  toUiLevelNormalizedSpec,
  type DesignContextNode,
  type RpcMethod,
  type RpcResponse,
} from "@figcp/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { resolveFigcpHome } from "./auth.ts";
import { detectUiLevel, getUiLevelConfig } from "./cli/ui-level-addon.ts";
import { loadCodeConnectMap, matchCodeConnect } from "./code-connect.ts";
import type { TransportNode } from "./transport/node.ts";

function getCacheDir(): string {
  const dir = process.env.FIGCP_CACHE_DIR || join(resolveFigcpHome(), "cache");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function pruneOldCache(cacheDir: string, maxFiles = 20, maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const files = readdirSync(cacheDir);
    const now = Date.now();
    const stats: Array<{ path: string; mtime: number }> = [];
    for (const f of files) {
      const p = join(cacheDir, f);
      try {
        stats.push({ path: p, mtime: statSync(p).mtimeMs });
      } catch {
        // Ignore deleted/broken entries
      }
    }
    stats.sort((a, b) => b.mtime - a.mtime);

    for (let i = 0; i < stats.length; i++) {
      const item = stats[i]!;
      if (i >= maxFiles || now - item.mtime > maxAgeMs) {
        try {
          unlinkSync(item.path);
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Best-effort cache cleanup
  }
}

export function spillLargePayload(
  toolName: string,
  payload: unknown,
  thresholdBytes = 65_536,
  customCacheDir?: string,
  inlineMeta?: Record<string, unknown>,
): { text: string; fullOutputPath?: string } {
  const json = JSON.stringify(payload, null, 2);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= thresholdBytes) {
    return { text: json };
  }

  const cacheDir = customCacheDir || getCacheDir();
  pruneOldCache(cacheDir);
  const fileName = `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filePath = join(cacheDir, fileName);
  writeFileSync(filePath, json, "utf8");

  const preview =
    typeof payload === "object" && payload !== null
      ? Array.isArray(payload)
        ? `[Array of ${payload.length} items]`
        : Object.keys(payload as object).slice(0, 10).join(", ")
      : String(payload).slice(0, 200);

  const summary = {
    spilled: true,
    tool: toolName,
    byteLength: bytes,
    fullOutputPath: filePath,
    summary: `Response payload (${Math.round(bytes / 1024)} KB) exceeded 64 KB threshold. Full JSON written to disk.`,
    preview,
    ...(inlineMeta ? inlineMeta : {}),
  };

  return {
    text: JSON.stringify(summary, null, 2),
    fullOutputPath: filePath,
  };
}

async function safeSendCommand(
  transport: TransportNode,
  options: {
    method: RpcMethod;
    params?: Record<string, unknown>;
    fileKey?: string;
    timeoutMs?: number;
  },
): Promise<RpcResponse> {
  try {
    return await transport.sendCommand(options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    let hint = "Run `figcp --doctor` to inspect connection and configuration health.";
    if (msg.includes("No Figma documents connected")) {
      hint = "Open Figma Desktop -> Plugins -> Development -> figcp to connect.";
    } else if (msg.includes("Multiple Figma documents connected")) {
      hint = "Pass `fileKey` in tool arguments. Call `figma_status` to see connected files.";
    } else if (msg.includes("timed out")) {
      hint = "Plugin script timed out in Figma Desktop worker. Check script or increase timeoutMs.";
    }
    return {
      type: "rpc_response",
      id: "err",
      ok: false,
      error: {
        name: "TransportError",
        message: `${msg}\nHint: ${hint}`,
      },
      logs: [],
      durationMs: 0,
    };
  }
}

export function createFigcpMcpServer(transport: TransportNode): McpServer {
  const server = new McpServer({
    name: "figcp",
    version: "0.2.0",
  });

  server.tool(
    "figma_status",
    "Check figcp connection status, role, port, connected Figma Desktop files, and recent manual edits made on the canvas by the user.",
    {
      fileKey: z.string().optional().describe("Target fileKey when multiple files are connected."),
      sinceChangeSeq: z.number().int().nonnegative().optional().describe("Only return manual changes with seq > sinceChangeSeq."),
    },
    async ({ fileKey, sinceChangeSeq }) => {
      let connectedFiles: unknown[] = [];
      try {
        connectedFiles = await transport.listConnectedFiles();
      } catch {
        // Ignored if stopped
      }

      if (connectedFiles.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  role: transport.role,
                  port: transport.port,
                  connectedFiles: [],
                  status: "disconnected",
                  hint: "No Figma documents connected. In Figma Desktop: Plugins -> Development -> figcp to connect.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (!fileKey && connectedFiles.length > 1) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  role: transport.role,
                  port: transport.port,
                  connectedFiles,
                  status: "connected",
                  hint: "Multiple Figma documents connected. Pass fileKey to inspect a specific document or view document changes.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const response = await safeSendCommand(transport, {
        method: "figma_status",
        params: sinceChangeSeq !== undefined ? { sinceSeq: sinceChangeSeq } : {},
        fileKey,
      });

      if (!response.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(response.error, null, 2) }],
        };
      }

      const result = {
        role: transport.role,
        port: transport.port,
        connectedFiles,
        activeDocument: response.result,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

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
      const response = await safeSendCommand(transport, {
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
      format: z.enum(["figma", "dtcg"]).optional().default("figma").describe("Output format: standard 'figma' snapshot or standard W3C 'dtcg' design tokens (compatible with Terrazzo and Tailwind v4)."),
    },
    async ({ fileKey, fontQuery, pageQuery, maxPages, format }) => {
      const response = await safeSendCommand(transport, {
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

      if (format === "dtcg") {
        const dtcg = toDtcgTokens(parsed.data);
        const spilled = spillLargePayload("inspect_design_system_dtcg", dtcg);
        return {
          content: [{ type: "text", text: spilled.text }],
        };
      }

      const spilled = spillLargePayload("inspect_design_system", parsed.data);
      return {
        content: [{ type: "text", text: spilled.text }],
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
      const response = await safeSendCommand(transport, {
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
      const errorIssues = lintIssues.filter((i) => i.severity === "error");
      const spilled = spillLargePayload("inspect_node_bounds", { node: data.node, lintIssues }, 65_536, undefined, {
        lintIssueCount: lintIssues.length,
        errorIssues: errorIssues.slice(0, 10),
      });

      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text",
          text: spilled.text,
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
      const response = await safeSendCommand(transport, {
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

  server.tool(
    "get_design_context",
    "Extract code-generation design context from a Figma node subtree: computed CSS/Tailwind geometry, Auto Layout (flexbox), fills, borders, typography, shadows, matching local Code Connect components (figcp.map.json), and optional offline NormalizedSpec export for ui-level visual verification.",
    {
      nodeId: z.string().optional().describe("Target node ID ('5031:4449'). Defaults to current selection."),
      fileKey: z.string().optional().describe("Target Figma fileKey when multiple files are connected."),
      maxDepth: z.number().int().min(0).max(10).optional().describe("Maximum subtree traversal depth (default 6)."),
      includeScreenshot: z.boolean().optional().describe("Capture reference PNG screenshot of the design context root."),
      screenshotScale: z.number().min(0.5).max(4).optional().describe("PNG export scale factor (default 2)."),
      workspaceDir: z.string().optional().describe("Frontend workspace directory to search for figcp.map.json (defaults to server cwd)."),
      exportUiLevelDir: z.string().optional().describe("Optional directory path to write spec.json and reference.png ready for ui-level."),
    },
    async ({ nodeId, fileKey, maxDepth, includeScreenshot, screenshotScale, workspaceDir, exportUiLevelDir }) => {
      const normalized = nodeId ? normalizeNodeId(nodeId) : undefined;
      const effectiveScreenshot = includeScreenshot ?? Boolean(exportUiLevelDir);
      const effectiveScale = screenshotScale ?? 2;
      const response = await safeSendCommand(transport, {
        method: "get_design_context",
        params: {
          ...(normalized ? { nodeId: normalized } : {}),
          ...(maxDepth !== undefined ? { maxDepth } : {}),
          ...(effectiveScreenshot ? { includeScreenshot: true } : {}),
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

      const parsed = GetDesignContextResultSchema.safeParse(response.result);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: "ValidationError",
                  message: `Invalid get_design_context payload: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const rawResult = parsed.data as unknown as { root: DesignContextNode; screenshotBase64?: string };
      const rootNode = rawResult.root;

      // 1. Resolve Code Connect mappings (figcp.map.json)
      const codeConnectMap = loadCodeConnectMap(workspaceDir);
      function attachCodeConnect(node: DesignContextNode) {
        if (node.component?.name) {
          const matched = matchCodeConnect(codeConnectMap, node.component.name);
          if (matched) {
            node.codeConnect = matched;
          }
        }
        if (node.children) {
          for (const child of node.children) {
            attachCodeConnect(child);
          }
        }
      }
      attachCodeConnect(rootNode);

      // 2. Export offline ui-level spec if requested
      let uiLevelExportPath: string | undefined;
      if (exportUiLevelDir) {
        const destDir = resolve(exportUiLevelDir);
        mkdirSync(destDir, { recursive: true });
        const hasPng = Boolean(rawResult.screenshotBase64);
        if (rawResult.screenshotBase64) {
          const refImgPath = join(destDir, "reference.png");
          writeFileSync(refImgPath, Buffer.from(rawResult.screenshotBase64, "base64"));
        }
        const spec = toUiLevelNormalizedSpec(rootNode, undefined, undefined, {
          deviceScaleFactor: effectiveScale,
          ...(hasPng ? { imagePath: "reference.png" } : {}),
        });
        const specPath = join(destDir, "spec.json");
        writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
        uiLevelExportPath = specPath;
      }

      const uiLevelConfig = getUiLevelConfig();
      const uiLevelInstalled = detectUiLevel();
      const uiLevelMeta = {
        available: uiLevelInstalled,
        status: uiLevelConfig.uiLevel ?? "disabled",
        package: "ui-level (npm)",
        npmUrl: "https://www.npmjs.com/package/ui-level",
        ...(uiLevelExportPath
          ? {
              exportedSpecPath: uiLevelExportPath,
              suggestedCommand: `npx ui-level check --spec ${uiLevelExportPath}`,
            }
          : {}),
      };

      const payload = {
        root: rootNode,
        codeConnectMapLoaded: Boolean(codeConnectMap),
        uiLevel: uiLevelMeta,
      };

      const spilled = spillLargePayload("get_design_context", payload, 65_536, undefined, {
        codeConnectMapLoaded: Boolean(codeConnectMap),
        uiLevel: uiLevelMeta,
      });
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text",
          text: spilled.text,
        },
      ];

      if (rawResult.screenshotBase64) {
        content.push({
          type: "image",
          data: rawResult.screenshotBase64,
          mimeType: "image/png",
        });
      }

      return { content };
    },
  );

  server.tool(
    "export_node_assets",
    "Export a Figma node as SVG (vector/icons) or PNG (raster/imagery). Returns the content inline or saves to outputDir.",
    {
      nodeId: z.string().optional().describe("Target node ID ('5031:4449'). Defaults to selection."),
      fileKey: z.string().optional().describe("Target Figma fileKey when multiple files are connected."),
      format: z.enum(["SVG", "PNG"]).optional().default("SVG").describe("Export format: 'SVG' (default) or 'PNG'."),
      scale: z.number().min(0.5).max(4).optional().describe("PNG export scale (default 2)."),
      outputDir: z.string().optional().describe("Optional directory to write asset file. If omitted, returns asset inline."),
      filename: z.string().optional().describe("Optional output filename. Defaults to sanitized node name."),
    },
    async ({ nodeId, fileKey, format, scale, outputDir, filename }) => {
      const normalized = nodeId ? normalizeNodeId(nodeId) : undefined;
      const fmt = format ?? "SVG";
      const response = await safeSendCommand(transport, {
        method: "export_node_assets",
        params: {
          ...(normalized ? { nodeId: normalized } : {}),
          format: fmt,
          ...(scale !== undefined ? { scale } : {}),
        },
        fileKey,
      });

      if (!response.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(response.error, null, 2) }],
        };
      }

      const parsedAsset = ExportNodeAssetsResultSchema.safeParse(response.result);
      if (!parsedAsset.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: "ValidationError",
                  message: `Invalid export_node_assets payload: ${parsedAsset.error.issues[0]?.message ?? "schema mismatch"}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const res = parsedAsset.data;

      if (outputDir) {
        const destDir = resolve(outputDir);
        mkdirSync(destDir, { recursive: true });
        const safeName = (filename || res.nodeName).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) || "asset";
        const ext = fmt === "PNG" ? "png" : "svg";
        const targetPath = join(destDir, `${safeName}.${ext}`);

        // Security check: ensure targetPath is strictly inside destDir
        const resolvedTarget = resolve(targetPath);
        if (resolvedTarget !== destDir && !resolvedTarget.startsWith(destDir + sep)) {
          throw new Error("Invalid output filename or path traversal detected.");
        }

        if (fmt === "PNG") {
          writeFileSync(targetPath, Buffer.from(res.content, "base64"));
        } else {
          writeFileSync(targetPath, res.content, "utf8");
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  savedPath: targetPath,
                  format: fmt,
                  nodeId: res.nodeId,
                  nodeName: res.nodeName,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (fmt === "PNG") {
        return {
          content: [
            {
              type: "image",
              data: res.content,
              mimeType: "image/png",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: res.content,
          },
        ],
      };
    },
  );

  return server;
}
