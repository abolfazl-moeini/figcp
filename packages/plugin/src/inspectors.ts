import { type DesignSystemSnapshot, type NodeBoundsSummary, normalizeNodeId } from "@figcp/shared";

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
        break;
      }
    }
    return `{${names.join(" -> ")}}`;
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
            valuesByMode[modeId] = val;
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
      paint: paintStyles.map((s) => ({ id: s.id, name: s.name })),
      text: textStyles.map((s) => ({
        id: s.id,
        name: s.name,
        fontName: s.fontName,
        fontSize: s.fontSize,
      })),
      effect: effectStyles.map((s) => ({ id: s.id, name: s.name })),
    },
    componentSets,
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
