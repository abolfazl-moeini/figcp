import type { ExportHtmlParams, ExportHtmlResult } from "@figcp/shared";
import { normalizeNodeId } from "@figcp/shared/utils";

const VECTOR_TYPES = new Set([
  "VECTOR",
  "STAR",
  "LINE",
  "ELLIPSE",
  "POLYGON",
  "BOOLEAN_OPERATION",
]);

const SCALAR_VAR_MAP: ReadonlyArray<readonly [string, string]> = [
  ["itemSpacing", "gap"],
  ["paddingTop", "padding-top"],
  ["paddingRight", "padding-right"],
  ["paddingBottom", "padding-bottom"],
  ["paddingLeft", "padding-left"],
  ["cornerRadius", "border-radius"],
  ["topLeftRadius", "border-top-left-radius"],
  ["topRightRadius", "border-top-right-radius"],
  ["bottomRightRadius", "border-bottom-right-radius"],
  ["bottomLeftRadius", "border-bottom-left-radius"],
];

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hasRtlChars(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
}

function toCssVarName(figmaName: string): string {
  const slug = figmaName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `--${slug || "token"}`;
}

function sanitizeClassName(name: string, index: number): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug ? `fg-${slug}-${index}` : `fg-node-${index}`;
}

function formatRgbColor(color: { r: number; g: number; b: number; a?: number }): string {
  const hex = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");
  const base = `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
  if (color.a !== undefined && color.a < 1) {
    return `${base}${hex(color.a)}`;
  }
  return base;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    out += chars[(triplet >> 18) & 63] ?? "";
    out += chars[(triplet >> 12) & 63] ?? "";
    out += i + 1 < bytes.length ? (chars[(triplet >> 6) & 63] ?? "=") : "=";
    out += i + 2 < bytes.length ? (chars[triplet & 63] ?? "=") : "=";
  }
  return out;
}

function uint8ArrayToUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i] ?? 0);
  }
  try {
    return decodeURIComponent(escape(s));
  } catch {
    return s;
  }
}

function stripXmlHeader(svg: string): string {
  return svg
    .replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, "")
    .replace(/^\s*<!DOCTYPE[\s\S]*?>\s*/i, "")
    .trim();
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function hasVisibleImageFill(node: SceneNode): boolean {
  const rec = node as unknown as { fills?: unknown };
  if (!Array.isArray(rec.fills)) return false;
  return rec.fills.some(
    (p) =>
      p &&
      typeof p === "object" &&
      (p as { type?: unknown }).type === "IMAGE" &&
      (p as { visible?: unknown }).visible !== false &&
      ((p as { opacity?: unknown }).opacity === undefined || Number((p as { opacity?: unknown }).opacity) > 0),
  );
}

function isPureVectorSubtree(node: SceneNode, depth: number, count: { total: number }): boolean {
  if (depth > 4 || count.total > 25) return false;
  if (node.type === "TEXT" || hasVisibleImageFill(node)) return false;
  count.total++;
  if (VECTOR_TYPES.has(node.type)) return true;
  if (!("children" in node) || !Array.isArray(node.children)) return false;
  const visibleChildren = (node.children as SceneNode[]).filter((c) => c.visible !== false);
  if (visibleChildren.length === 0) return false;
  return visibleChildren.every((c) => isPureVectorSubtree(c, depth + 1, count));
}

function isVectorOnlyIcon(node: SceneNode): boolean {
  const rec = node as unknown as { isAsset?: unknown; width?: number; height?: number };
  const w = typeof rec.width === "number" ? rec.width : 0;
  const h = typeof rec.height === "number" ? rec.height : 0;
  if (w <= 0 || h <= 0) return false;
  if (rec.isAsset === true) return true;
  if (VECTOR_TYPES.has(node.type) && !hasVisibleImageFill(node)) return true;
  if (w > 160 || h > 160) return false;
  if ("children" in node && Array.isArray(node.children)) {
    const visibleChildren = (node.children as SceneNode[]).filter((c) => c.visible !== false);
    const count = { total: 0 };
    if (visibleChildren.length > 0 && visibleChildren.every((c) => isPureVectorSubtree(c, 1, count))) {
      return true;
    }
  }
  return false;
}

function extractAliasId(raw: unknown): string | null {
  if (Array.isArray(raw)) return extractAliasId(raw[0]);
  if (raw && typeof raw === "object" && "id" in raw && typeof (raw as { id?: unknown }).id === "string") {
    return (raw as { id: string }).id;
  }
  return null;
}

function extractFirstPaintBoundColorId(paints: unknown): string | null {
  if (!Array.isArray(paints)) return null;
  for (const p of paints) {
    if (!p || typeof p !== "object") continue;
    const paint = p as {
      type?: unknown;
      visible?: unknown;
      opacity?: unknown;
      boundVariables?: { color?: unknown };
    };
    if (paint.type !== "SOLID" || paint.visible === false || (typeof paint.opacity === "number" && paint.opacity <= 0)) {
      continue;
    }
    const id = extractAliasId(paint.boundVariables?.color);
    if (id) return id;
  }
  return null;
}

async function getCachedVariable(
  figmaApi: PluginAPI,
  varId: string,
  varCache: Map<string, Variable | null>,
): Promise<Variable | null> {
  if (varCache.has(varId)) {
    return varCache.get(varId) ?? null;
  }
  let resolved: Variable | null = null;
  try {
    if (figmaApi.variables && typeof figmaApi.variables.getVariableByIdAsync === "function") {
      resolved = await figmaApi.variables.getVariableByIdAsync(varId);
    }
  } catch {
    resolved = null;
  }
  varCache.set(varId, resolved);
  return resolved;
}

async function resolveBoundVariable(
  figmaApi: PluginAPI,
  aliasId: string,
  varCache: Map<string, Variable | null>,
  cssVariables: Record<string, string>,
  varIdToCssName: Map<string, string>,
  cssNameToVarId: Map<string, string>,
): Promise<{ varName: string; fallback: string | null } | null> {
  const rootVar = await getCachedVariable(figmaApi, aliasId, varCache);
  if (!rootVar) return null;

  let varName = varIdToCssName.get(rootVar.id);
  if (!varName) {
    const baseName = toCssVarName(rootVar.name);
    varName = baseName;
    const owner = cssNameToVarId.get(varName);
    if (owner && owner !== rootVar.id) {
      let suffix = 2;
      while (cssNameToVarId.has(`${baseName}-${suffix}`)) {
        suffix++;
      }
      varName = `${baseName}-${suffix}`;
    }
    varIdToCssName.set(rootVar.id, varName);
    cssNameToVarId.set(varName, rootVar.id);
  }
  let currentVar: Variable | null = rootVar;
  let terminalVal: unknown = undefined;
  const visited = new Set<string>([aliasId]);

  for (let hop = 0; hop < 5 && currentVar; hop++) {
    const rawVal = Object.values(currentVar.valuesByMode ?? {})[0];
    if (
      rawVal &&
      typeof rawVal === "object" &&
      "type" in rawVal &&
      (rawVal as { type?: unknown }).type === "VARIABLE_ALIAS" &&
      "id" in rawVal &&
      typeof (rawVal as { id?: unknown }).id === "string"
    ) {
      const nextId = (rawVal as { id: string }).id;
      if (visited.has(nextId)) break;
      visited.add(nextId);
      currentVar = await getCachedVariable(figmaApi, nextId, varCache);
    } else {
      terminalVal = rawVal;
      break;
    }
  }

  let fallback: string | null = null;
  if (terminalVal && typeof terminalVal === "object" && "r" in terminalVal && "g" in terminalVal && "b" in terminalVal) {
    fallback = formatRgbColor(terminalVal as { r: number; g: number; b: number; a?: number });
  } else if (typeof terminalVal === "number" && Number.isFinite(terminalVal)) {
    fallback = `${terminalVal}px`;
  } else if (typeof terminalVal === "string") {
    fallback = terminalVal;
  }

  if (fallback !== null && !(varName in cssVariables)) {
    cssVariables[varName] = fallback;
  }

  return { varName, fallback };
}

async function applyVariableBindings(
  cssMap: Record<string, string>,
  node: SceneNode,
  figmaApi: PluginAPI,
  varCache: Map<string, Variable | null>,
  cssVariables: Record<string, string>,
  varIdToCssName: Map<string, string>,
  cssNameToVarId: Map<string, string>,
): Promise<void> {
  const rec = node as unknown as {
    boundVariables?: Record<string, unknown>;
    fills?: unknown;
    strokes?: unknown;
  };
  const bv = rec.boundVariables;

  const fillVarId = extractAliasId(bv?.fills) ?? extractFirstPaintBoundColorId(rec.fills);
  if (fillVarId) {
    const resolved = await resolveBoundVariable(figmaApi, fillVarId, varCache, cssVariables, varIdToCssName, cssNameToVarId);
    if (resolved) {
      const effectiveFallback =
        resolved.fallback ??
        (node.type === "TEXT" ? cssMap.color : cssMap["background-color"] ?? cssMap.background) ??
        "inherit";
      const expr = `var(${resolved.varName}, ${effectiveFallback})`;
      if (node.type === "TEXT") {
        cssMap.color = expr;
      } else {
        delete cssMap.background;
        cssMap["background-color"] = expr;
      }
    }
  }

  const strokeVarId = extractAliasId(bv?.strokes) ?? extractFirstPaintBoundColorId(rec.strokes);
  if (strokeVarId) {
    const resolved = await resolveBoundVariable(figmaApi, strokeVarId, varCache, cssVariables, varIdToCssName, cssNameToVarId);
    if (resolved) {
      cssMap["border-color"] = `var(${resolved.varName}, ${resolved.fallback ?? "currentColor"})`;
    }
  }

  if (bv) {
    for (const [figmaField, cssProp] of SCALAR_VAR_MAP) {
      const id = extractAliasId(bv[figmaField]);
      if (!id) continue;
      const resolved = await resolveBoundVariable(figmaApi, id, varCache, cssVariables, varIdToCssName, cssNameToVarId);
      if (resolved) {
        cssMap[cssProp] = resolved.fallback
          ? `var(${resolved.varName}, ${resolved.fallback})`
          : `var(${resolved.varName})`;
      }
    }
  }
}

function applyLayoutSizingOverrides(
  cssMap: Record<string, string>,
  node: SceneNode,
  parentLayoutMode: string | undefined,
): void {
  const rec = node as unknown as {
    layoutSizingHorizontal?: string;
    layoutSizingVertical?: string;
  };

  if (rec.layoutSizingHorizontal === "FILL") {
    delete cssMap.width;
    if (parentLayoutMode === "HORIZONTAL") {
      cssMap.flex = "1 0 0";
      cssMap["min-width"] = "0";
    } else {
      cssMap["align-self"] = "stretch";
      cssMap.width = "100%";
    }
  } else if (rec.layoutSizingHorizontal === "HUG") {
    cssMap.width = "fit-content";
  }

  if (rec.layoutSizingVertical === "FILL") {
    delete cssMap.height;
    if (parentLayoutMode === "VERTICAL") {
      cssMap.flex = "1 0 0";
      cssMap["min-height"] = "0";
    } else if (parentLayoutMode === "HORIZONTAL") {
      cssMap["align-self"] = "stretch";
      cssMap.height = "auto";
    } else {
      cssMap.height = "100%";
    }
  } else if (rec.layoutSizingVertical === "HUG") {
    cssMap.height = "fit-content";
  }
}

function applyPositioningOverrides(
  cssMap: Record<string, string>,
  node: SceneNode,
  parentNode: SceneNode | null,
  isRoot: boolean,
  hasAbsoluteChild: boolean,
  hasVisibleChildren: boolean,
): void {
  const rec = node as unknown as {
    layoutMode?: string;
    layoutPositioning?: string;
    absoluteBoundingBox?: { x: number; y: number } | null;
  };
  if (hasAbsoluteChild || (hasVisibleChildren && (!rec.layoutMode || rec.layoutMode === "NONE"))) {
    cssMap.position = "relative";
  }
  if (!isRoot && parentNode) {
    const parentRec = parentNode as unknown as {
      layoutMode?: string;
      absoluteBoundingBox?: { x: number; y: number } | null;
    };
    if (rec.layoutPositioning === "ABSOLUTE" || parentRec.layoutMode === "NONE" || !parentRec.layoutMode) {
      cssMap.position = "absolute";
      if (rec.absoluteBoundingBox && parentRec.absoluteBoundingBox) {
        cssMap.left = `${Math.round(rec.absoluteBoundingBox.x - parentRec.absoluteBoundingBox.x)}px`;
        cssMap.top = `${Math.round(rec.absoluteBoundingBox.y - parentRec.absoluteBoundingBox.y)}px`;
      }
    }
  }
}

function mapFontStyleToCss(style?: string): { fontWeight?: number; fontStyle?: "italic" } {
  if (!style) return {};
  const lower = style.trim().toLowerCase();
  const compact = lower.replace(/[\s_-]+/g, "");
  const fontStyle: "italic" | undefined =
    lower.includes("italic") || lower.includes("oblique") ? "italic" : undefined;

  let fontWeight: number | undefined;
  if (compact.includes("thin") || compact.includes("hairline")) fontWeight = 100;
  else if (compact.includes("extralight") || compact.includes("ultralight")) fontWeight = 200;
  else if (compact.includes("light")) fontWeight = 300;
  else if (compact.includes("medium")) fontWeight = 500;
  else if (compact.includes("semibold") || compact.includes("demibold")) fontWeight = 600;
  else if (compact.includes("extrabold") || compact.includes("ultrabold")) fontWeight = 800;
  else if (compact.includes("black") || compact.includes("heavy")) fontWeight = 900;
  else if (compact.includes("bold")) fontWeight = 700;
  else if (compact.includes("regular") || compact.includes("normal")) fontWeight = 400;

  return {
    ...(fontWeight !== undefined ? { fontWeight } : {}),
    ...(fontStyle ? { fontStyle } : {}),
  };
}

function renderTextContent(node: TextNode): { innerHtml: string; isRtl: boolean } {
  const rawText = typeof node.characters === "string" ? node.characters : "";
  const isRtl = hasRtlChars(rawText);
  const formatText = (t: string) => escapeHtml(t).replace(/\r?\n/g, "<br />");

  const styledFn = (node as unknown as {
    getStyledTextSegments?: (fields: string[]) => Array<{
      characters?: string;
      fontName?: { family?: string; style?: string };
      fontSize?: number;
      fills?: Array<{ type?: string; visible?: boolean; opacity?: number; color?: { r: number; g: number; b: number } }>;
      textDecoration?: string;
    }>;
  }).getStyledTextSegments;

  if (typeof styledFn === "function") {
    try {
      const segs = styledFn.call(node, ["fontName", "fontSize", "fills", "textDecoration"]);
      if (Array.isArray(segs) && segs.length > 1) {
        const spans = segs.map((seg) => {
          const styles: string[] = [];
          if (seg.fontName?.family) {
            styles.push(`font-family: '${escapeHtml(seg.fontName.family)}'`);
          }
          const mapped = mapFontStyleToCss(seg.fontName?.style);
          if (mapped.fontWeight !== undefined) {
            styles.push(`font-weight: ${mapped.fontWeight}`);
          }
          if (mapped.fontStyle) {
            styles.push(`font-style: ${mapped.fontStyle}`);
          }
          if (typeof seg.fontSize === "number") {
            styles.push(`font-size: ${seg.fontSize}px`);
          }
          const solidFill = Array.isArray(seg.fills)
            ? seg.fills.find((f) => f && f.type === "SOLID" && f.visible !== false && f.color)
            : undefined;
          if (solidFill?.color) {
            styles.push(`color: ${formatRgbColor({ ...solidFill.color, a: solidFill.opacity })}`);
          }
          if (seg.textDecoration === "UNDERLINE") {
            styles.push("text-decoration: underline");
          } else if (seg.textDecoration === "STRIKETHROUGH") {
            styles.push("text-decoration: line-through");
          }
          const attr = styles.length > 0 ? ` style="${styles.join("; ")}"` : "";
          return `<span${attr}>${formatText(seg.characters ?? "")}</span>`;
        });
        return { innerHtml: spans.join(""), isRtl };
      }
    } catch {
      // Fallback to plain characters below
    }
  }

  return { innerHtml: formatText(rawText), isRtl };
}

async function resolveTargetNode(figmaApi: PluginAPI, nodeId?: string): Promise<SceneNode> {
  if (nodeId) {
    const normalized = normalizeNodeId(nodeId);
    const found = await figmaApi.getNodeByIdAsync(normalized);
    if (!found || found.type === "DOCUMENT" || found.type === "PAGE") {
      throw new Error(`Node "${normalized}" was not found or is not a SceneNode.`);
    }
    return found as SceneNode;
  }
  const selected = figmaApi.currentPage.selection[0] ?? null;
  if (!selected) {
    throw new Error("No nodeId provided and nothing is currently selected in Figma.");
  }
  return selected;
}

export async function handleExportToHtml(
  figmaApi: PluginAPI,
  params: ExportHtmlParams & { timeoutMs?: number } = {},
): Promise<ExportHtmlResult> {
  const target = await resolveTargetNode(figmaApi, params.nodeId);

  const mode = params.mode === "fragment" ? "fragment" : "standalone";
  const useCssVars = params.useCssVars !== false;
  const inlineSvgs = params.inlineSvgs !== false;
  const inlineImages = params.inlineImages === true;
  const maxDepth = typeof params.maxDepth === "number" ? Math.max(0, Math.min(15, Math.floor(params.maxDepth))) : 8;
  const maxNodes = typeof params.maxNodes === "number" ? Math.max(1, Math.min(2000, Math.floor(params.maxNodes))) : 400;
  const budgetMs = typeof params.timeoutMs === "number" && params.timeoutMs > 3000 ? params.timeoutMs - 2000 : 25_000;
  const deadlineMs = Date.now() + budgetMs;

  const stats = { nodeCount: 0, svgCount: 0, imageCount: 0, truncated: false };
  const warnings: string[] = [];
  const cssRules: string[] = [];
  const cssVariables: Record<string, string> = {};
  const varCache = new Map<string, Variable | null>();
  const varIdToCssName = new Map<string, string>();
  const cssNameToVarId = new Map<string, string>();
  let totalTextCount = 0;
  let rtlTextCount = 0;
  let maxNodesWarned = false;
  let timeBudgetWarned = false;

  const visitNode = async (
    node: SceneNode,
    parentNode: SceneNode | null,
    depth: number,
  ): Promise<string> => {
    if ("visible" in node && node.visible === false) return "";
    if (Date.now() >= deadlineMs) {
      stats.truncated = true;
      if (!timeBudgetWarned) {
        timeBudgetWarned = true;
        warnings.push("Export stopped early to stay within time budget. Export a smaller section or increase timeoutMs.");
      }
      return "";
    }
    if (stats.nodeCount >= maxNodes) {
      stats.truncated = true;
      if (!maxNodesWarned) {
        maxNodesWarned = true;
        warnings.push(`Export truncated at maxNodes (${maxNodes}). Increase maxNodes or export a smaller child nodeId.`);
      }
      return "";
    }

    stats.nodeCount++;
    const className = sanitizeClassName(node.name || node.type, stats.nodeCount);
    const cssMap: Record<string, string> = {};

    const getCssFn = (node as unknown as { getCSSAsync?: () => Promise<Record<string, string>> }).getCSSAsync;
    if (typeof getCssFn === "function") {
      try {
        const rawCss = await withTimeout(getCssFn.call(node), 1500, "getCSSAsync");
        if (rawCss && typeof rawCss === "object") {
          Object.assign(cssMap, rawCss);
        }
      } catch {
        // Best-effort CSS extraction
      }
    }

    const visibleChildren =
      "children" in node && Array.isArray(node.children)
        ? (node.children as SceneNode[]).filter((c) => c.visible !== false)
        : [];
    const hasAbsoluteChild = visibleChildren.some(
      (c) => (c as unknown as { layoutPositioning?: string }).layoutPositioning === "ABSOLUTE",
    );
    const parentLayoutMode = parentNode
      ? ((parentNode as unknown as { layoutMode?: string }).layoutMode ?? undefined)
      : undefined;

    applyLayoutSizingOverrides(cssMap, node, parentLayoutMode);
    applyPositioningOverrides(cssMap, node, parentNode, depth === 0, hasAbsoluteChild, visibleChildren.length > 0);
    if (useCssVars) {
      await applyVariableBindings(cssMap, node, figmaApi, varCache, cssVariables, varIdToCssName, cssNameToVarId);
    }

    // Asset Branch 1: Inline SVG
    if (inlineSvgs && isVectorOnlyIcon(node)) {
      let svgContent = "";
      try {
        const maybeSvg = await withTimeout(
          (node.exportAsync as (opts: unknown) => Promise<unknown>)({
            format: "SVG_STRING",
          }),
          2500,
          "exportAsync(SVG_STRING)",
        );
        if (typeof maybeSvg === "string") {
          svgContent = stripXmlHeader(maybeSvg);
        } else {
          svgContent = stripXmlHeader(uint8ArrayToUtf8(maybeSvg as Uint8Array));
        }
      } catch {
        warnings.push(`Could not export SVG for "${node.name}" (${node.id}).`);
      }

      if (svgContent.length > 0) {
        stats.svgCount++;
      }
      const svgCss: Record<string, string> = {
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        "flex-shrink": "0",
      };
      for (const prop of ["position", "left", "top", "width", "height", "flex", "min-width", "min-height"]) {
        if (cssMap[prop] !== undefined) {
          svgCss[prop] = cssMap[prop]!;
        }
      }
      cssRules.push(`.${className} { ${Object.entries(svgCss).map(([k, v]) => `${k}: ${v};`).join(" ")} }`);
      return `<span class="${className}" data-figma-id="${escapeHtml(node.id)}">${svgContent}</span>`;
    }

    // Asset Branch 2: Image Fill
    if (hasVisibleImageFill(node)) {
      stats.imageCount++;
      if (inlineImages) {
        try {
          const pngBytes = await node.exportAsync({
            format: "PNG",
            constraint: { type: "SCALE", value: 1 },
          });
          cssMap["background-image"] = `url("data:image/png;base64,${uint8ToBase64(pngBytes)}")`;
          cssMap["background-size"] = "cover";
          cssMap["background-position"] = "center";
        } catch {
          warnings.push(`Image export failed for "${node.name}" (${node.id}).`);
        }
      } else {
        cssMap["background-color"] = cssMap["background-color"] ?? "#e2e8f0";
        warnings.push(
          `Image fill on "${node.name}" (${node.id}) replaced with placeholder (set inlineImages: true to embed base64 PNG).`,
        );
      }
    }

    // Text Node Branch
    if (node.type === "TEXT") {
      const { innerHtml, isRtl } = renderTextContent(node as TextNode);
      totalTextCount++;
      if (isRtl) rtlTextCount++;
      cssMap.margin = cssMap.margin ?? "0";
      cssRules.push(`.${className} { ${Object.entries(cssMap).map(([k, v]) => `${k}: ${v};`).join(" ")} }`);
      return `<p class="${className}" data-figma-id="${escapeHtml(node.id)}"${isRtl ? ' dir="rtl"' : ""}>${innerHtml}</p>`;
    }

    // Container / Leaf Branch
    cssRules.push(`.${className} { ${Object.entries(cssMap).map(([k, v]) => `${k}: ${v};`).join(" ")} }`);
    let childrenHtml = "";
    if (visibleChildren.length > 0) {
      if (depth >= maxDepth) {
        stats.truncated = true;
        warnings.push(`Subtree of "${node.name}" (${node.id}) truncated at maxDepth (${maxDepth}).`);
      } else {
        for (const child of visibleChildren) {
          childrenHtml += await visitNode(child, node, depth + 1);
        }
      }
    }
    return `<div class="${className}" data-figma-id="${escapeHtml(node.id)}">${childrenHtml}</div>`;
  };

  const bodyHtml = await visitNode(target, null, 0);
  const varEntries = Object.entries(cssVariables);
  const rootVarsBlock =
    varEntries.length > 0
      ? `:root {\n${varEntries.map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}\n\n`
      : "";
  const css = `${rootVarsBlock}${cssRules.join("\n")}`.replace(/<\/style/gi, "<\\/style");

  const isRtlRoot = totalTextCount > 0 && rtlTextCount >= totalTextCount / 2;
  // Never put dir="rtl" on <html>/<body> because Figma's Auto Layout flex-direction: row
  // always lays out children left-to-right regardless of language; dir="rtl" on <html> mirrors
  // the entire Flexbox/Grid coordinate system. Apply dir="rtl" only on Persian text nodes.
  const html =
    mode === "fragment"
      ? bodyHtml
      : [
          "<!DOCTYPE html>",
          `<html lang="${isRtlRoot ? "fa" : "en"}">`,
          "<head>",
          '  <meta charset="UTF-8" />',
          '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
          `  <title>${escapeHtml(target.name || "Figma Export")}</title>`,
          "  <style>",
          "*, *::before, *::after { box-sizing: border-box; }",
          "body, p { margin: 0; }",
          "body > div { margin: 0 auto; max-width: 100%; }",
          css,
          "  </style>",
          "</head>",
          "<body>",
          bodyHtml,
          "</body>",
          "</html>",
        ].join("\n");

  return {
    html,
    css,
    cssVariables,
    stats,
    warnings,
  };
}
