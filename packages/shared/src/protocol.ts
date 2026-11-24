import { z } from "zod";

export const RpcMethodSchema = z.enum([
  "ping",
  "run_figma_js",
  "inspect_design_system",
  "inspect_node_bounds",
  "figma_undo",
]);

export type RpcMethod = z.infer<typeof RpcMethodSchema>;

export const PluginHelloMessageSchema = z.object({
  type: z.literal("hello"),
  fileKey: z.string().min(1),
  fileName: z.string().min(1),
  pageName: z.string().default(""),
  pluginVersion: z.string().default("0.1.0"),
});

export type PluginHelloMessage = z.infer<typeof PluginHelloMessageSchema>;

export const RpcRequestSchema = z.object({
  type: z.literal("rpc_request"),
  id: z.string().min(1),
  method: RpcMethodSchema,
  params: z.record(z.unknown()).default({}),
  timeoutMs: z.number().int().positive().max(180_000).default(30_000),
});

export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const LogEntrySchema = z.object({
  level: z.enum(["log", "warn", "error"]),
  args: z.array(z.string()),
});

export type LogEntry = z.infer<typeof LogEntrySchema>;

export const RpcErrorPayloadSchema = z.object({
  name: z.string().default("Error"),
  message: z.string(),
  stack: z.string().optional(),
});

export type RpcErrorPayload = z.infer<typeof RpcErrorPayloadSchema>;

export const RpcResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("rpc_response"),
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
    logs: z.array(LogEntrySchema).default([]),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("rpc_response"),
    id: z.string().min(1),
    ok: z.literal(false),
    error: RpcErrorPayloadSchema,
    logs: z.array(LogEntrySchema).default([]),
    durationMs: z.number().nonnegative().optional(),
  }),
]);

export type RpcResponse = z.infer<typeof RpcResponseSchema>;

export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

export const LintSeveritySchema = z.enum(["error", "warning", "info"]);
export type LintSeverity = z.infer<typeof LintSeveritySchema>;

export const LintIssueSchema = z.object({
  rule: z.string(),
  severity: LintSeveritySchema,
  nodeId: z.string(),
  nodeName: z.string(),
  message: z.string(),
});

export type LintIssue = z.infer<typeof LintIssueSchema>;

export const LayoutModeSchema = z.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]);
export type LayoutMode = z.infer<typeof LayoutModeSchema>;

export interface NodeBoundsSummary {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  isMask?: boolean;
  clipsContent?: boolean;
  layoutMode?: LayoutMode;
  layoutPositioning?: "AUTO" | "ABSOLUTE";
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  strokeWeight?: number;
  absoluteBoundingBox?: BoundingBox | null;
  absoluteRenderBounds?: BoundingBox | null;
  hasVisibleSolidFill?: boolean;
  hasVisibleSolidStroke?: boolean;
  unboundSolidFillCount?: number;
  unboundSolidStrokeCount?: number;
  fillStyleId?: string | null;
  strokeStyleId?: string | null;
  boundVariables?: Record<string, unknown>;
  characters?: string;
  textAlignHorizontal?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  truncatedChildrenCount?: number;
  children?: NodeBoundsSummary[];
}

export const NodeBoundsSummarySchema: z.ZodType<NodeBoundsSummary> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    name: z.string(),
    type: z.string().min(1),
    visible: z.boolean().optional(),
    opacity: z.number().optional(),
    isMask: z.boolean().optional(),
    clipsContent: z.boolean().optional(),
    layoutMode: LayoutModeSchema.optional(),
    layoutPositioning: z.enum(["AUTO", "ABSOLUTE"]).optional(),
    itemSpacing: z.number().optional(),
    paddingTop: z.number().optional(),
    paddingRight: z.number().optional(),
    paddingBottom: z.number().optional(),
    paddingLeft: z.number().optional(),
    strokeWeight: z.number().optional(),
    absoluteBoundingBox: BoundingBoxSchema.nullable().optional(),
    absoluteRenderBounds: BoundingBoxSchema.nullable().optional(),
    hasVisibleSolidFill: z.boolean().optional(),
    hasVisibleSolidStroke: z.boolean().optional(),
    unboundSolidFillCount: z.number().int().nonnegative().optional(),
    unboundSolidStrokeCount: z.number().int().nonnegative().optional(),
    fillStyleId: z.string().nullable().optional(),
    strokeStyleId: z.string().nullable().optional(),
    boundVariables: z.record(z.unknown()).optional(),
    characters: z.string().optional(),
    textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
    truncatedChildrenCount: z.number().int().nonnegative().optional(),
    children: z.array(NodeBoundsSummarySchema).optional(),
  }),
);

export const InspectNodeBoundsResultSchema = z.object({
  node: NodeBoundsSummarySchema,
  screenshotBase64: z.string().optional(),
});

export interface ConnectedFileInfo {
  fileKey: string;
  fileName: string;
  pageName: string;
  pluginVersion: string;
  connectedAt: number;
}

export const ConnectedFileInfoSchema = z.object({
  fileKey: z.string().min(1),
  fileName: z.string(),
  pageName: z.string(),
  pluginVersion: z.string(),
  connectedAt: z.number(),
});

export const DesignSystemSnapshotSchema = z.object({
  fileName: z.string(),
  currentPage: z.string(),
  variableCollections: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      modes: z.array(z.object({ modeId: z.string(), name: z.string() })),
      variables: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          resolvedType: z.string(),
          valuesByMode: z.record(z.unknown()),
        }),
      ),
    }),
  ),
  styles: z.object({
    paint: z.array(z.object({ id: z.string(), name: z.string() })),
    text: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        fontName: z.object({ family: z.string(), style: z.string() }).optional(),
        fontSize: z.number().optional(),
      }),
    ),
    effect: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  componentSets: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      pageName: z.string(),
      variantCount: z.number().int().nonnegative(),
      properties: z.record(z.unknown()),
    }),
  ),
  fonts: z.array(z.object({ family: z.string(), style: z.string() })).optional(),
  truncated: z.boolean().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  pagesLoaded: z.number().int().nonnegative().optional(),
});

export type DesignSystemSnapshot = z.infer<typeof DesignSystemSnapshotSchema>;

export const HttpRpcBodySchema = z.object({
  method: RpcMethodSchema,
  params: z.record(z.unknown()).optional().default({}),
  fileKey: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(180_000).optional(),
});

export type HttpRpcBody = z.infer<typeof HttpRpcBodySchema>;

export const PingResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("figcp"),
  role: z.literal("leader"),
});

export const FollowerFilesResponseSchema = z.object({
  ok: z.boolean(),
  files: z.array(ConnectedFileInfoSchema).optional(),
  error: z.string().optional(),
});

export const FollowerRpcResponseSchema = z.object({
  ok: z.boolean(),
  response: RpcResponseSchema.optional(),
  error: z.string().optional(),
});

/**
 * Normalizes Figma URL node IDs ("5031-4449") into Plugin API format ("5031:4449").
 */
export function normalizeNodeId(id: string): string {
  const trimmed = id.trim();
  if (/^\d+-\d+$/.test(trimmed)) {
    return trimmed.replace("-", ":");
  }
  return trimmed;
}
