import { type RpcRequest, type RpcResponse } from "@figcp/shared";
import { SerialPluginExecutor } from "./executor.ts";
import { createPluginHelpers } from "./helpers.ts";
import {
  handleExportNodeAssets,
  handleFigmaUndo,
  handleGetDesignContext,
  handleInspectDesignSystem,
  handleInspectNodeBounds,
  type InspectDesignSystemParams,
  type InspectNodeBoundsParams,
  type UndoParams,
} from "./inspectors.ts";

const PLUGIN_VERSION = "0.2.1";
const executor = new SerialPluginExecutor();
const helpersFactory = (guardedFigma: unknown) => createPluginHelpers(guardedFigma as PluginAPI);
const SESSION_FILE_KEY = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

interface RecordedChange {
  seq: number;
  id: string;
  name?: string;
  type: string;
  changeType: string;
  timestamp: number;
}

let isAgentCommandRunning = false;
let suppressChangesUntil = 0;
let changeSeq = 0;
const changeBuffer: RecordedChange[] = [];
const MAX_CHANGES = 100;

function recordNodeChanges(changes: ReadonlyArray<{ id: string; type: string; node?: unknown }>): void {
  if (isAgentCommandRunning || Date.now() < suppressChangesUntil) return;
  for (const change of changes) {
    changeSeq++;
    const node = change.node as { name?: unknown; type?: unknown } | undefined;
    changeBuffer.push({
      seq: changeSeq,
      id: change.id,
      name: node && typeof node.name === "string" ? node.name : undefined,
      type: node && typeof node.type === "string" ? node.type : "UNKNOWN",
      changeType: change.type,
      timestamp: Date.now(),
    });
    if (changeBuffer.length > MAX_CHANGES) {
      changeBuffer.shift();
    }
  }
}

let trackedPage: PageNode | null = null;
const onPageNodeChange = (event: { nodeChanges?: Array<{ id: string; type: string; node?: unknown }> }) => {
  if (event && Array.isArray(event.nodeChanges)) {
    recordNodeChanges(event.nodeChanges);
  }
};

function bindCurrentPageWatcher(): void {
  try {
    if (trackedPage && typeof trackedPage.off === "function") {
      trackedPage.off("nodechange", onPageNodeChange as any);
    }
    if (figma.currentPage && typeof figma.currentPage.on === "function") {
      trackedPage = figma.currentPage;
      trackedPage.on("nodechange", onPageNodeChange as any);
    }
  } catch {
    // Ignore if mock/environment does not support PageNode.on("nodechange")
  }
}

bindCurrentPageWatcher();

figma.showUI(__html__, { width: 260, height: 76, themeColors: true });

function computeLocalFileKey(): string {
  if (typeof figma.fileKey === "string" && figma.fileKey.length > 0) {
    return figma.fileKey;
  }
  return SESSION_FILE_KEY;
}

function sendHello(): void {
  try {
    figma.ui.postMessage({
      type: "hello",
      fileKey: computeLocalFileKey(),
      fileName: figma.root.name || "Untitled",
      pageName: figma.currentPage?.name ?? "",
      pluginVersion: PLUGIN_VERSION,
    });
  } catch {
    // Ignore postMessage errors if UI is closing
  }
}

if (typeof figma.on === "function") {
  figma.on("currentpagechange", () => {
    bindCurrentPageWatcher();
    sendHello();
  });
}

function isValidRpcRequest(msg: unknown): msg is RpcRequest {
  if (!msg || typeof msg !== "object") return false;
  const rec = msg as Record<string, unknown>;
  if (rec.type !== "rpc_request") return false;
  if (typeof rec.id !== "string" || rec.id.length === 0) return false;
  if (typeof rec.method !== "string" || rec.method.length === 0) return false;
  if (rec.params !== undefined && (typeof rec.params !== "object" || rec.params === null || Array.isArray(rec.params))) {
    return false;
  }
  return true;
}

figma.ui.onmessage = async (msg: unknown) => {
  if (!msg || typeof msg !== "object") return;
  const rec = msg as { type?: string };

  if (rec.type === "ui_ready") {
    sendHello();
    return;
  }

  if (rec.type !== "rpc_request") return;
  if (!isValidRpcRequest(msg)) {
    const rawId = typeof (msg as { id?: unknown }).id === "string" ? (msg as { id: string }).id : "";
    if (rawId) {
      figma.ui.postMessage({
        type: "rpc_response",
        id: rawId,
        ok: false,
        error: { name: "ValidationError", message: "Malformed rpc_request payload" },
        logs: [],
      } satisfies RpcResponse);
    }
    return;
  }

  const req = msg;
  const params = req.params ?? {};
  const startedAt = Date.now();

  try {
    if (req.method === "ping") {
      const response: RpcResponse = {
        type: "rpc_response",
        id: req.id,
        ok: true,
        result: {
          pong: true,
          fileKey: computeLocalFileKey(),
          fileName: figma.root.name,
          pageName: figma.currentPage.name,
        },
        logs: [],
        durationMs: Date.now() - startedAt,
      };
      figma.ui.postMessage(response);
      return;
    }

    if (req.method === "figma_status") {
      const sinceSeq = typeof params.sinceSeq === "number" ? params.sinceSeq : undefined;
      const changes =
        sinceSeq !== undefined
          ? changeBuffer.filter((c) => c.seq > sinceSeq)
          : changeBuffer.slice(-20);

      const response: RpcResponse = {
        type: "rpc_response",
        id: req.id,
        ok: true,
        result: {
          fileKey: computeLocalFileKey(),
          fileName: figma.root.name,
          pageName: figma.currentPage.name,
          changeSeq,
          manualChanges: changes,
        },
        logs: [],
        durationMs: Date.now() - startedAt,
      };
      figma.ui.postMessage(response);
      return;
    }

    isAgentCommandRunning = true;
    try {
      if (req.method === "run_figma_js") {
        const code = typeof params.code === "string" ? params.code : "";
        const commitUndo = typeof params.commitUndo === "boolean" ? params.commitUndo : true;
        const outcome = await executor.execute(code, figma, helpersFactory, {
          timeoutMs: req.timeoutMs,
          commitUndo,
        });
        const response: RpcResponse = outcome.ok
          ? {
              type: "rpc_response",
              id: req.id,
              ok: true,
              result: outcome.result,
              logs: outcome.logs,
              durationMs: outcome.durationMs,
            }
          : {
              type: "rpc_response",
              id: req.id,
              ok: false,
              error: outcome.error,
              logs: outcome.logs,
              durationMs: outcome.durationMs,
            };
        figma.ui.postMessage(response);
        return;
      }

      if (req.method === "inspect_design_system") {
        const result = await executor.runTask(() =>
          handleInspectDesignSystem(figma, params as InspectDesignSystemParams),
        );
        figma.ui.postMessage({
          type: "rpc_response",
          id: req.id,
          ok: true,
          result,
          logs: [],
          durationMs: Date.now() - startedAt,
        } satisfies RpcResponse);
        return;
      }

      if (req.method === "inspect_node_bounds") {
        const result = await executor.runTask(() =>
          handleInspectNodeBounds(figma, params as InspectNodeBoundsParams),
        );
        figma.ui.postMessage({
          type: "rpc_response",
          id: req.id,
          ok: true,
          result,
          logs: [],
          durationMs: Date.now() - startedAt,
        } satisfies RpcResponse);
        return;
      }

      if (req.method === "figma_undo") {
        const result = await executor.runTask(() => handleFigmaUndo(figma, params as UndoParams));
        figma.ui.postMessage({
          type: "rpc_response",
          id: req.id,
          ok: true,
          result,
          logs: [],
          durationMs: Date.now() - startedAt,
        } satisfies RpcResponse);
        return;
      }

      if (req.method === "get_design_context") {
        const result = await executor.runTask(() =>
          handleGetDesignContext(figma, {
            nodeId: typeof params.nodeId === "string" ? params.nodeId : undefined,
            maxDepth: typeof params.maxDepth === "number" ? params.maxDepth : undefined,
            includeScreenshot:
              typeof params.includeScreenshot === "boolean" ? params.includeScreenshot : undefined,
            screenshotScale:
              typeof params.screenshotScale === "number" ? params.screenshotScale : undefined,
          }),
        );
        figma.ui.postMessage({
          type: "rpc_response",
          id: req.id,
          ok: true,
          result,
          logs: [],
          durationMs: Date.now() - startedAt,
        } satisfies RpcResponse);
        return;
      }

      if (req.method === "export_node_assets") {
        const result = await executor.runTask(() =>
          handleExportNodeAssets(figma, {
            nodeId: typeof params.nodeId === "string" ? params.nodeId : undefined,
            format: params.format === "PNG" ? "PNG" : "SVG",
            scale: typeof params.scale === "number" ? params.scale : undefined,
          }),
        );
        figma.ui.postMessage({
          type: "rpc_response",
          id: req.id,
          ok: true,
          result,
          logs: [],
          durationMs: Date.now() - startedAt,
        } satisfies RpcResponse);
        return;
      }
    } finally {
      isAgentCommandRunning = false;
      suppressChangesUntil = Date.now() + 1500;
    }

    throw new Error(`Unsupported RPC method: ${String(req.method)}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    figma.ui.postMessage({
      type: "rpc_response",
      id: req.id,
      ok: false,
      error: { name: error.name, message: error.message, stack: error.stack },
      logs: [],
      durationMs: Date.now() - startedAt,
    } satisfies RpcResponse);
  }
};
