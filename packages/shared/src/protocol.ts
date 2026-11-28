import { z } from "zod";

export const RpcMethodSchema = z.enum([
  "ping",
  "run_figma_js",
  "inspect_design_system",
  "inspect_node_bounds",
  "figma_undo",
  "figma_status",
  "get_design_context",
  "export_node_assets",
  "export_to_html",
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
  fontName?: { family: string; style: string };
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
    fontName: z.object({ family: z.string(), style: z.string() }).optional(),
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
    paint: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        hex: z.string().optional(),
        opacity: z.number().optional(),
      }),
    ),
    text: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        fontName: z.object({ family: z.string(), style: z.string() }).optional(),
        fontSize: z.number().optional(),
        lineHeight: z.unknown().optional(),
        letterSpacing: z.unknown().optional(),
      }),
    ),
    effect: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string().optional(),
        radius: z.number().optional(),
        colorHex: z.string().optional(),
        offset: z.object({ x: z.number(), y: z.number() }).optional(),
      }),
    ),
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
  components: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        pageName: z.string(),
      }),
    )
    .optional(),
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

export const ExportNodeAssetsResultSchema = z.object({
  ok: z.literal(true),
  format: z.enum(["SVG", "PNG"]),
  content: z.string(),
  nodeId: z.string(),
  nodeName: z.string(),
});

export const DesignContextNodeSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    name: z.string(),
    type: z.string().min(1),
    rect: BoundingBoxSchema,
    relativeRect: BoundingBoxSchema.optional(),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]).optional(),
    itemSpacing: z.number().optional(),
    padding: z
      .object({
        top: z.number(),
        right: z.number(),
        bottom: z.number(),
        left: z.number(),
      })
      .optional(),
    alignItems: z.string().optional(),
    justifyContent: z.string().optional(),
    primarySizing: z.string().optional(),
    counterSizing: z.string().optional(),
    fills: z
      .array(
        z.object({
          hex: z.string().optional(),
          opacity: z.number().optional(),
          boundVariable: z.string().optional(),
        }),
      )
      .optional(),
    strokes: z
      .array(
        z.object({
          hex: z.string().optional(),
          opacity: z.number().optional(),
          boundVariable: z.string().optional(),
          width: z.number().optional(),
        }),
      )
      .optional(),
    cornerRadius: z.number().optional(),
    effects: z
      .array(
        z.object({
          type: z.string(),
          colorHex: z.string().optional(),
          radius: z.number().optional(),
          offset: z.object({ x: z.number(), y: z.number() }).optional(),
        }),
      )
      .optional(),
    typography: z
      .object({
        characters: z.string().optional(),
        fontFamily: z.string().optional(),
        fontWeight: z.string().optional(),
        fontSize: z.number().optional(),
        lineHeight: z.union([z.string(), z.number()]).optional(),
        letterSpacing: z.union([z.string(), z.number()]).optional(),
        textAlign: z.string().optional(),
      })
      .optional(),
    component: z
      .object({
        id: z.string(),
        name: z.string(),
        properties: z.record(z.unknown()).optional(),
      })
      .optional(),
    children: z.array(DesignContextNodeSchema).optional(),
  }),
);

export const GetDesignContextResultSchema = z.object({
  root: DesignContextNodeSchema,
  screenshotBase64: z.string().optional(),
});

export { normalizeNodeId } from "./utils.ts";

export const ExportHtmlParamsSchema = z.object({
  nodeId: z.string().min(1).optional(),
  mode: z.enum(["standalone", "fragment"]).default("standalone"),
  useCssVars: z.boolean().default(true),
  inlineSvgs: z.boolean().default(true),
  inlineImages: z.boolean().default(false),
  maxDepth: z.number().int().min(0).max(15).default(8),
  maxNodes: z.number().int().min(1).max(2000).default(400),
});
export type ExportHtmlParams = z.input<typeof ExportHtmlParamsSchema>;
export type ExportHtmlResolvedParams = z.output<typeof ExportHtmlParamsSchema>;
export const ExportHtmlResultSchema = z.object({
  html: z.string(),
  css: z.string(),
  cssVariables: z.record(z.string()),
  stats: z.object({ nodeCount: z.number().int().nonnegative(), svgCount: z.number().int().nonnegative(), imageCount: z.number().int().nonnegative(), truncated: z.boolean() }),
  warnings: z.array(z.string()),
});
export type ExportHtmlResult = z.infer<typeof ExportHtmlResultSchema>;
