import { type DesignSystemSnapshot, type NodeBoundsSummary } from "@figcp/shared";
import { normalizeNodeId } from "@figcp/shared/utils";

export interface InspectDesignSystemParams {
  fontQuery?: string;
  pageQuery?: string;
  maxPages?: number;
}

export interface InspectNodeBoundsParams {
  nodeId?: string;
  maxDepth?: number;
  includeScreenshot?: boolean;
  screenshotScale?: number;
}

export interface UndoParams {
  action?: "undo" | "snapshot";
  title?: string;
}

const MAX_PNG_DIMENSION_PX = 4096;
const MAX_PNG_BYTES = 10 * 1024 * 1024; // 10 MiB (~13.3 MiB base64)

function uint8ToBase64(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    out += chars[(triplet >> 18) & 63];
    out += chars[(triplet >> 12) & 63];
    out += i + 1 < bytes.length ? chars[(triplet >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? chars[triplet & 63] : "=";
  }
  return out;
}

function uint8ArrayToUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]!);
  }
  try {
    return decodeURIComponent(escape(s));
  } catch {
    return s;
  }
}

function formatColorValue(val: unknown): unknown {
  if (val && typeof val === "object" && "r" in val && "g" in val && "b" in val) {
    const c = val as { r: number; g: number; b: number; a?: number };
    const r = Math.round(c.r * 255).toString(16).padStart(2, "0");
    const g = Math.round(c.g * 255).toString(16).padStart(2, "0");
    const b = Math.round(c.b * 255).toString(16).padStart(2, "0");
    if (c.a !== undefined && c.a < 1) {
      const a = Math.round(c.a * 255).toString(16).padStart(2, "0");
      return `#${r}${g}${b}${a}`;
    }
    return `#${r}${g}${b}`;
  }
  return val;
}

export async function handleInspectDesignSystem(
  figmaApi: PluginAPI,
  params: InspectDesignSystemParams = {},
): Promise<DesignSystemSnapshot> {
  const [collections, allVars, paintStyles, textStyles, effectStyles] = await Promise.all([
    figmaApi.variables.getLocalVariableCollectionsAsync(),
    figmaApi.variables.getLocalVariablesAsync(),
    figmaApi.getLocalPaintStylesAsync(),
    figmaApi.getLocalTextStylesAsync(),
    figmaApi.getLocalEffectStylesAsync(),
  ]);

  const varById = new Map(allVars.map((v) => [v.id, v]));

  const resolveAliasChain = (aliasId: string, modeId: string): string => {
    const names: string[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = aliasId;
    let terminalVal: unknown;

    for (let hop = 0; hop < 10 && currentId; hop++) {
      if (visited.has(currentId)) {
        names.push(`${varById.get(currentId)?.name ?? currentId}[cycle]`);
        break;
      }
      visited.add(currentId);
      const target = varById.get(currentId);
      if (!target) {
        names.push(currentId);
        break;
      }
      names.push(target.name);
      const nextVal =
        target.valuesByMode?.[modeId] ?? Object.values(target.valuesByMode ?? {})[0];
      if (
        nextVal &&
        typeof nextVal === "object" &&
        "type" in nextVal &&
        (nextVal as VariableAlias).type === "VARIABLE_ALIAS"
      ) {
        currentId = (nextVal as VariableAlias).id;
      } else {
        terminalVal = nextVal;
        break;
      }
    }
    const resolvedSuffix =
      terminalVal !== undefined ? ` = ${JSON.stringify(formatColorValue(terminalVal))}` : "";
    return `{${names.join(" -> ")}}${resolvedSuffix}`;
  };

  const variableCollections = collections.map((col) => {
    const colVars = allVars.filter((v) => v.variableCollectionId === col.id);
    return {
      id: col.id,
      name: col.name,
      modes: col.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
      variables: colVars.map((v) => {
        const valuesByMode: Record<string, unknown> = {};
        for (const [modeId, val] of Object.entries(v.valuesByMode)) {
          if (val && typeof val === "object" && "type" in val && val.type === "VARIABLE_ALIAS") {
            valuesByMode[modeId] = resolveAliasChain((val as VariableAlias).id, modeId);
          } else {
            valuesByMode[modeId] = formatColorValue(val);
          }
        }
        return {
          id: v.id,
          name: v.name,
          resolvedType: v.resolvedType,
          valuesByMode,
        };
      }),
    };
  });

  const allPages = figmaApi.root.children;
  const pageFilter = params.pageQuery?.trim().toLowerCase();
  const matchingPages = pageFilter
    ? allPages.filter((p) => p.name.toLowerCase().includes(pageFilter))
    : allPages;
  const maxPages = params.maxPages ?? 50;
  const pagesToInspect = matchingPages.slice(0, maxPages);
  const truncated = matchingPages.length > pagesToInspect.length;

  const componentSets: DesignSystemSnapshot["componentSets"] = [];
  const components: NonNullable<DesignSystemSnapshot["components"]> = [];
  for (const page of pagesToInspect) {
    if (typeof page.loadAsync === "function") {
      await page.loadAsync();
    }
    const sets = page.findAll((n) => n.type === "COMPONENT_SET") as ComponentSetNode[];
    for (const set of sets) {
      componentSets.push({
        id: set.id,
        name: set.name,
        pageName: page.name,
        variantCount: set.children.length,
        properties: set.componentPropertyDefinitions ?? {},
      });
    }
    const standalones = page.findAll(
      (n) => n.type === "COMPONENT" && (!n.parent || n.parent.type !== "COMPONENT_SET"),
    ) as ComponentNode[];
    for (const comp of standalones) {
      components.push({
        id: comp.id,
        name: comp.name,
        pageName: page.name,
      });
    }
  }

  let fonts: Array<{ family: string; style: string }> | undefined;
  if (params.fontQuery) {
    const q = params.fontQuery.toLowerCase();
    const available = await figmaApi.listAvailableFontsAsync();
    fonts = available
      .filter((f) => f.fontName.family.toLowerCase().includes(q))
      .slice(0, 50)
      .map((f) => ({ family: f.fontName.family, style: f.fontName.style }));
  }

  return {
    fileName: figmaApi.root.name,
    currentPage: figmaApi.currentPage.name,
    variableCollections,
    styles: {
      paint: paintStyles.map((s) => {
        const solid = (s as unknown as { paints?: readonly Paint[] }).paints?.find((p) => p.type === "SOLID") as SolidPaint | undefined;
        let hex: string | undefined;
        if (solid && solid.color) {
          const r = Math.round(solid.color.r * 255).toString(16).padStart(2, "0");
          const g = Math.round(solid.color.g * 255).toString(16).padStart(2, "0");
          const b = Math.round(solid.color.b * 255).toString(16).padStart(2, "0");
          hex = `#${r}${g}${b}`;
        }
        return { id: s.id, name: s.name, hex, opacity: solid?.opacity };
      }),
      text: textStyles.map((s) => ({
        id: s.id,
        name: s.name,
        fontName: s.fontName,
        fontSize: s.fontSize,
      })),
      effect: effectStyles.map((s) => {
        const eff = (s as unknown as { effects?: readonly Effect[] }).effects?.[0];
        let colorHex: string | undefined;
        if (eff && "color" in eff && (eff as { color?: RGBA }).color) {
          const c = (eff as { color: RGBA }).color;
          const r = Math.round(c.r * 255).toString(16).padStart(2, "0");
          const g = Math.round(c.g * 255).toString(16).padStart(2, "0");
          const b = Math.round(c.b * 255).toString(16).padStart(2, "0");
          colorHex = `#${r}${g}${b}`;
        }
        return {
          id: s.id,
          name: s.name,
          type: eff?.type,
          radius: eff && "radius" in eff ? eff.radius : undefined,
          colorHex,
          offset: eff && "offset" in eff ? eff.offset : undefined,
        };
      }),
    },
    componentSets,
    components,
    totalPages: allPages.length,
    pagesLoaded: pagesToInspect.length,
    ...(truncated ? { truncated } : {}),
    ...(fonts ? { fonts } : {}),
  };
}

function analyzeSolidPaints(
  paints: unknown,
  nodeBoundArray: unknown,
): { hasVisibleSolid: boolean; unboundSolidCount: number } {
  if (!Array.isArray(paints)) {
    return { hasVisibleSolid: false, unboundSolidCount: 0 };
  }
  const hasNodeLevelBinding = Array.isArray(nodeBoundArray) && nodeBoundArray.length > 0;
  let hasVisibleSolid = false;
  let unboundSolidCount = 0;

  for (let i = 0; i < paints.length; i++) {
    const p = paints[i];
    if (!p || typeof p !== "object") continue;
    const paint = p as Paint & { boundVariables?: { color?: unknown } };
    if (paint.type !== "SOLID" || paint.visible === false || (paint.opacity !== undefined && paint.opacity <= 0)) {
      continue;
    }
    hasVisibleSolid = true;
    const hasPerPaintBinding = Boolean(paint.boundVariables && paint.boundVariables.color);
    const hasIndexedNodeBinding =
      hasNodeLevelBinding && (nodeBoundArray as unknown[])[i] !== undefined;
    if (!hasPerPaintBinding && !hasIndexedNodeBinding && !hasNodeLevelBinding) {
      unboundSolidCount++;
    } else if (!hasPerPaintBinding && hasNodeLevelBinding && !hasIndexedNodeBinding) {
      // Node-level boundVariables.fills only covers indices present in the array
      unboundSolidCount++;
    }
  }

  return { hasVisibleSolid, unboundSolidCount };
}

function summarizeNode(node: SceneNode, depth: number, maxDepth: number): NodeBoundsSummary {
  const rec = node as unknown as Record<string, unknown>;
  const summary: NodeBoundsSummary = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: "visible" in node ? node.visible : true,
  };

  if (typeof rec.opacity === "number") {
    summary.opacity = rec.opacity;
  }
  if (typeof rec.isMask === "boolean") {
    summary.isMask = rec.isMask;
  }
  if ("clipsContent" in node && typeof rec.clipsContent === "boolean") {
    summary.clipsContent = rec.clipsContent;
  }
  if ("layoutMode" in node && typeof rec.layoutMode === "string") {
    summary.layoutMode = rec.layoutMode as NodeBoundsSummary["layoutMode"];
  }
  if ("layoutPositioning" in node && typeof rec.layoutPositioning === "string") {
    summary.layoutPositioning = rec.layoutPositioning as NodeBoundsSummary["layoutPositioning"];
  }
  if (typeof rec.itemSpacing === "number") summary.itemSpacing = rec.itemSpacing;
  if (typeof rec.paddingTop === "number") summary.paddingTop = rec.paddingTop;
  if (typeof rec.paddingRight === "number") summary.paddingRight = rec.paddingRight;
  if (typeof rec.paddingBottom === "number") summary.paddingBottom = rec.paddingBottom;
  if (typeof rec.paddingLeft === "number") summary.paddingLeft = rec.paddingLeft;
  if (typeof rec.strokeWeight === "number") summary.strokeWeight = rec.strokeWeight;

  if ("absoluteBoundingBox" in node) {
    summary.absoluteBoundingBox = (rec.absoluteBoundingBox as NodeBoundsSummary["absoluteBoundingBox"]) ?? null;
  }
  if ("absoluteRenderBounds" in node) {
    summary.absoluteRenderBounds = (rec.absoluteRenderBounds as NodeBoundsSummary["absoluteRenderBounds"]) ?? null;
  }

  const boundVars = rec.boundVariables && typeof rec.boundVariables === "object"
    ? (rec.boundVariables as Record<string, unknown>)
    : undefined;
  if (boundVars) {
    summary.boundVariables = boundVars;
  }

  if ("fills" in node) {
    const fillInfo = analyzeSolidPaints(rec.fills, boundVars?.fills);
    summary.hasVisibleSolidFill = fillInfo.hasVisibleSolid;
    summary.unboundSolidFillCount = fillInfo.unboundSolidCount;
  }
  if ("strokes" in node) {
    const strokeInfo = analyzeSolidPaints(rec.strokes, boundVars?.strokes);
    summary.hasVisibleSolidStroke = strokeInfo.hasVisibleSolid;
    summary.unboundSolidStrokeCount = strokeInfo.unboundSolidCount;
  }
  if (typeof rec.fillStyleId === "string" && rec.fillStyleId.length > 0) {
    summary.fillStyleId = rec.fillStyleId;
  }
  if (typeof rec.strokeStyleId === "string" && rec.strokeStyleId.length > 0) {
    summary.strokeStyleId = rec.strokeStyleId;
  }
  if (node.type === "TEXT") {
    summary.characters = node.characters;
    summary.textAlignHorizontal = node.textAlignHorizontal;
    if (typeof (node as TextNode).fontName === "object" && (node as TextNode).fontName !== null) {
      summary.fontName = {
        family: ((node as TextNode).fontName as FontName).family,
        style: ((node as TextNode).fontName as FontName).style,
      };
    }
  }

  if ("children" in node && Array.isArray(node.children)) {
    if (depth < maxDepth) {
      summary.children = node.children.map((child) => summarizeNode(child, depth + 1, maxDepth));
    } else if (node.children.length > 0) {
      summary.truncatedChildrenCount = node.children.length;
    }
  }

  return summary;
}

export async function handleInspectNodeBounds(
  figmaApi: PluginAPI,
  params: InspectNodeBoundsParams = {},
): Promise<{ node: NodeBoundsSummary; screenshotBase64?: string }> {
  let target: SceneNode | null = null;

  if (params.nodeId) {
    const normalized = normalizeNodeId(params.nodeId);
    const found = await figmaApi.getNodeByIdAsync(normalized);
    if (!found || found.type === "DOCUMENT" || found.type === "PAGE") {
      throw new Error(`Node "${normalized}" was not found or is not a SceneNode.`);
    }
    target = found as SceneNode;
  } else {
    target = figmaApi.currentPage.selection[0] ?? null;
    if (!target) {
      throw new Error("No nodeId provided and nothing is currently selected in Figma.");
    }
  }

  const maxDepth = params.maxDepth ?? 4;
  const summary = summarizeNode(target, 0, maxDepth);

  let screenshotBase64: string | undefined;
  if (params.includeScreenshot) {
    const requestedScale = params.screenshotScale ?? 2;
    const box = summary.absoluteBoundingBox;
    let effectiveScale = requestedScale;
    if (box && (box.width * requestedScale > MAX_PNG_DIMENSION_PX || box.height * requestedScale > MAX_PNG_DIMENSION_PX)) {
      const maxDim = Math.max(box.width, box.height, 1);
      effectiveScale = Math.max(0.25, Math.min(requestedScale, MAX_PNG_DIMENSION_PX / maxDim));
    }

    const pngBytes = await target.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: effectiveScale },
    });
    if (pngBytes.length > MAX_PNG_BYTES) {
      throw new Error(
        `Exported PNG (${pngBytes.length} bytes) exceeds max safe payload (${MAX_PNG_BYTES} bytes). Use a smaller screenshotScale or inspect a child nodeId.`,
      );
    }
    screenshotBase64 = uint8ToBase64(pngBytes);
  }

  return {
    node: summary,
    ...(screenshotBase64 ? { screenshotBase64 } : {}),
  };
}

export async function handleFigmaUndo(
  figmaApi: PluginAPI,
  params: UndoParams = {},
): Promise<{ ok: true; action: "undo" | "snapshot"; title?: string }> {
  const action = params.action ?? "undo";
  if (action === "snapshot") {
    const title = params.title?.trim() || `figcp snapshot ${new Date().toISOString()}`;
    await figmaApi.saveVersionHistoryAsync(title);
    return { ok: true, action: "snapshot", title };
  }
  figmaApi.triggerUndo();
  return { ok: true, action: "undo" };
}

export interface DesignContextExtractedNode {
  id: string;
  name: string;
  type: string;
  rect: { x: number; y: number; width: number; height: number };
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
  itemSpacing?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  alignItems?: string;
  justifyContent?: string;
  primarySizing?: string;
  counterSizing?: string;
  fills?: Array<{ hex?: string; opacity?: number; boundVariable?: string }>;
  strokes?: Array<{ hex?: string; opacity?: number; boundVariable?: string; width?: number }>;
  cornerRadius?: number;
  effects?: Array<{ type: string; colorHex?: string; radius?: number; offset?: { x: number; y: number } }>;
  typography?: {
    characters?: string;
    fontFamily?: string;
    fontWeight?: string;
    fontSize?: number;
    lineHeight?: string | number;
    textAlign?: string;
  };
  component?: {
    id: string;
    name: string;
    properties?: Record<string, unknown>;
  };
  children?: DesignContextExtractedNode[];
}

export function extractDesignContextNode(node: SceneNode, depth = 0, maxDepth = 6): DesignContextExtractedNode {
  const box =
    "absoluteBoundingBox" in node && node.absoluteBoundingBox
      ? {
          x: Math.round(node.absoluteBoundingBox.x),
          y: Math.round(node.absoluteBoundingBox.y),
          width: Math.round(node.absoluteBoundingBox.width),
          height: Math.round(node.absoluteBoundingBox.height),
        }
      : { x: 0, y: 0, width: 0, height: 0 };

  const rec = node as unknown as Record<string, unknown>;
  const res: DesignContextExtractedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    rect: box,
  };

  if ("layoutMode" in node && typeof rec.layoutMode === "string" && rec.layoutMode !== "NONE") {
    res.layoutMode = rec.layoutMode as DesignContextExtractedNode["layoutMode"];
    if (typeof rec.itemSpacing === "number") res.itemSpacing = rec.itemSpacing;
    res.padding = {
      top: typeof rec.paddingTop === "number" ? rec.paddingTop : 0,
      right: typeof rec.paddingRight === "number" ? rec.paddingRight : 0,
      bottom: typeof rec.paddingBottom === "number" ? rec.paddingBottom : 0,
      left: typeof rec.paddingLeft === "number" ? rec.paddingLeft : 0,
    };
    if (typeof rec.primaryAxisAlignItems === "string") res.justifyContent = rec.primaryAxisAlignItems;
    if (typeof rec.counterAxisAlignItems === "string") res.alignItems = rec.counterAxisAlignItems;
    if (typeof rec.primaryAxisSizingMode === "string") res.primarySizing = rec.primaryAxisSizingMode;
    if (typeof rec.counterAxisSizingMode === "string") res.counterSizing = rec.counterAxisSizingMode;
  }

  if (typeof rec.cornerRadius === "number" && rec.cornerRadius > 0) {
    res.cornerRadius = rec.cornerRadius;
  }

  if ("fills" in node && Array.isArray(rec.fills)) {
    const fills: NonNullable<DesignContextExtractedNode["fills"]> = [];
    for (const p of rec.fills) {
      if (p.type === "SOLID" && p.color) {
        const r = Math.round(p.color.r * 255).toString(16).padStart(2, "0");
        const g = Math.round(p.color.g * 255).toString(16).padStart(2, "0");
        const b = Math.round(p.color.b * 255).toString(16).padStart(2, "0");
        fills.push({ hex: `#${r}${g}${b}`, opacity: p.opacity });
      }
    }
    if (fills.length > 0) res.fills = fills;
  }

  if ("strokes" in node && Array.isArray(rec.strokes)) {
    const strokes: NonNullable<DesignContextExtractedNode["strokes"]> = [];
    for (const p of rec.strokes) {
      if (p.type === "SOLID" && p.color) {
        const r = Math.round(p.color.r * 255).toString(16).padStart(2, "0");
        const g = Math.round(p.color.g * 255).toString(16).padStart(2, "0");
        const b = Math.round(p.color.b * 255).toString(16).padStart(2, "0");
        strokes.push({
          hex: `#${r}${g}${b}`,
          opacity: p.opacity,
          width: typeof rec.strokeWeight === "number" ? rec.strokeWeight : undefined,
        });
      }
    }
    if (strokes.length > 0) res.strokes = strokes;
  }

  if (node.type === "TEXT") {
    const tNode = node as TextNode;
    res.typography = {
      characters: tNode.characters,
      fontSize: typeof tNode.fontSize === "number" ? tNode.fontSize : undefined,
      fontFamily:
        typeof tNode.fontName === "object" && tNode.fontName !== null
          ? (tNode.fontName as FontName).family
          : undefined,
      fontWeight:
        typeof tNode.fontName === "object" && tNode.fontName !== null
          ? (tNode.fontName as FontName).style
          : undefined,
      textAlign: typeof tNode.textAlignHorizontal === "string" ? tNode.textAlignHorizontal : undefined,
    };
  }

  if (node.type === "INSTANCE") {
    const inst = node as InstanceNode;
    res.component = {
      id: inst.mainComponent?.id ?? inst.id,
      name: inst.mainComponent?.name ?? inst.name,
      properties: inst.componentProperties ?? {},
    };
  } else if (node.type === "COMPONENT") {
    res.component = {
      id: node.id,
      name: node.name,
    };
  }

  if ("children" in node && Array.isArray(node.children) && depth < maxDepth) {
    res.children = (node.children as SceneNode[])
      .filter((c) => c.visible !== false)
      .map((c) => extractDesignContextNode(c, depth + 1, maxDepth));
  }

  return res;
}

export async function handleGetDesignContext(
  figmaApi: PluginAPI,
  params: {
    nodeId?: string;
    maxDepth?: number;
    includeScreenshot?: boolean;
    screenshotScale?: number;
  } = {},
): Promise<{ root: DesignContextExtractedNode; screenshotBase64?: string }> {
  let target: SceneNode | null = null;
  if (params.nodeId) {
    const normalized = normalizeNodeId(params.nodeId);
    const found = await figmaApi.getNodeByIdAsync(normalized);
    if (!found || found.type === "DOCUMENT" || found.type === "PAGE") {
      throw new Error(`Node "${normalized}" was not found or is not a SceneNode.`);
    }
    target = found as SceneNode;
  } else {
    target = figmaApi.currentPage.selection[0] ?? null;
    if (!target) {
      throw new Error("No nodeId provided and nothing is currently selected in Figma.");
    }
  }

  const root = extractDesignContextNode(target, 0, params.maxDepth ?? 6);

  let screenshotBase64: string | undefined;
  if (params.includeScreenshot) {
    const scale = params.screenshotScale ?? 2;
    const pngBytes = await target.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale },
    });
    screenshotBase64 = uint8ToBase64(pngBytes);
  }

  return { root, ...(screenshotBase64 ? { screenshotBase64 } : {}) };
}

export async function handleExportNodeAssets(
  figmaApi: PluginAPI,
  params: { nodeId?: string; format?: "SVG" | "PNG"; scale?: number } = {},
): Promise<{ ok: true; format: "SVG" | "PNG"; content: string; nodeId: string; nodeName: string }> {
  let target: SceneNode | null = null;
  if (params.nodeId) {
    const normalized = normalizeNodeId(params.nodeId);
    const found = await figmaApi.getNodeByIdAsync(normalized);
    if (!found || found.type === "DOCUMENT" || found.type === "PAGE") {
      throw new Error(`Node "${normalized}" was not found or is not a SceneNode.`);
    }
    target = found as SceneNode;
  } else {
    target = figmaApi.currentPage.selection[0] ?? null;
    if (!target) {
      throw new Error("No nodeId provided and nothing is currently selected in Figma.");
    }
  }

  const format = params.format === "PNG" ? "PNG" : "SVG";
  if (format === "PNG") {
    const pngBytes = await target.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: params.scale ?? 2 },
    });
    return {
      ok: true,
      format: "PNG",
      content: uint8ToBase64(pngBytes),
      nodeId: target.id,
      nodeName: target.name,
    };
  } else {
    const svgBytes = await target.exportAsync({ format: "SVG" });
    const svgString = uint8ArrayToUtf8(svgBytes);
    return {
      ok: true,
      format: "SVG",
      content: svgString,
      nodeId: target.id,
      nodeName: target.name,
    };
  }
}
