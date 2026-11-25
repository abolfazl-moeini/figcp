export interface UiLevelStyleSpec {
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  borderTopWidth?: number;
  borderRightWidth?: number;
  borderBottomWidth?: number;
  borderLeftWidth?: number;
  borderTopLeftRadius?: number;
  borderTopRightRadius?: number;
  borderBottomRightRadius?: number;
  borderBottomLeftRadius?: number;
  rowGap?: number;
  columnGap?: number;
  fontSize?: number;
  lineHeight?: number;
  fontWeight?: number;
  letterSpacing?: number;
  fontFamily?: string;
  color?: string;
  backgroundColor?: string;
  display?: string;
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  width?: number;
  height?: number;
}

export interface UiLevelNodeSpec {
  id: string;
  figmaId?: string;
  selector: string;
  direction?: "ltr" | "rtl";
  rect: { x: number; y: number; width: number; height: number };
  styles: UiLevelStyleSpec;
  text?: string;
  codeConnect?: { file: string; export?: string };
}

export interface UiLevelNormalizedSpec {
  adapter: "figma";
  viewport: { width: number; height: number; deviceScaleFactor: number };
  nodes: UiLevelNodeSpec[];
  imagePath?: string;
}

export interface DesignContextNode {
  id: string;
  name: string;
  type: string;
  rect: { x: number; y: number; width: number; height: number };
  relativeRect?: { x: number; y: number; width: number; height: number };
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
    letterSpacing?: string | number;
    textAlign?: string;
  };
  component?: {
    id: string;
    name: string;
    properties?: Record<string, unknown>;
  };
  codeConnect?: {
    file: string;
    export?: string;
  };
  children?: DesignContextNode[];
}

function mapFontWeightToNumber(weight?: string): number | undefined {
  if (!weight) return undefined;
  const w = weight.trim().toLowerCase();
  const numeric = Number(w);
  if (Number.isFinite(numeric) && numeric >= 100 && numeric <= 1000) return numeric;
  if (w.includes("thin") || w.includes("hairline")) return 100;
  if (w.includes("extralight") || w.includes("ultralight")) return 200;
  if (w.includes("light")) return 300;
  if (w.includes("medium")) return 500;
  if (w.includes("semibold") || w.includes("demibold")) return 600;
  if (w.includes("extrabold") || w.includes("ultrabold")) return 800;
  if (w.includes("black") || w.includes("heavy")) return 900;
  if (w.includes("bold")) return 700;
  if (w.includes("regular") || w.includes("normal")) return 400;
  return undefined;
}

function parseNumericLineHeight(lh: string | number | undefined, fontSize?: number): number | undefined {
  if (typeof lh === "number" && Number.isFinite(lh)) return lh;
  if (typeof lh === "string" && lh.endsWith("%") && fontSize) {
    const pct = parseFloat(lh);
    if (Number.isFinite(pct)) return Math.round((pct / 100) * fontSize * 100) / 100;
  }
  return undefined;
}

function mapJustifyOrAlign(val?: string): string | undefined {
  if (!val) return undefined;
  const v = val.toUpperCase();
  if (v === "MIN") return "flex-start";
  if (v === "CENTER") return "center";
  if (v === "MAX") return "flex-end";
  if (v === "SPACE_BETWEEN") return "space-between";
  if (v === "BASELINE") return "baseline";
  return val.toLowerCase();
}

/**
 * Converts rich DesignContext tree into the flat NormalizedSpec format
 * natively consumed by `ui-level` (NormalizedSpecSchema).
 */
export function toUiLevelNormalizedSpec(
  root: DesignContextNode,
  viewportWidth?: number,
  viewportHeight?: number,
  options: { deviceScaleFactor?: number; imagePath?: string } = {},
): UiLevelNormalizedSpec {
  const width = Math.max(1, Math.round(viewportWidth ?? (root.rect.width > 0 ? root.rect.width : 1440)));
  const height = Math.max(1, Math.round(viewportHeight ?? (root.rect.height > 0 ? root.rect.height : 900)));
  const deviceScaleFactor = options.deviceScaleFactor ?? 2;
  const nodes: UiLevelNodeSpec[] = [];

  function visit(node: DesignContextNode, rootOrigin: { x: number; y: number }): void {
    const styles: UiLevelStyleSpec = {};

    if (node.layoutMode && node.layoutMode !== "NONE") {
      styles.display = "flex";
      styles.flexDirection = node.layoutMode === "HORIZONTAL" ? "row" : "column";
      if (node.itemSpacing !== undefined && node.itemSpacing > 0) {
        if (node.layoutMode === "HORIZONTAL") {
          styles.columnGap = node.itemSpacing;
        } else {
          styles.rowGap = node.itemSpacing;
        }
      }
      if (node.padding) {
        styles.paddingTop = node.padding.top;
        styles.paddingRight = node.padding.right;
        styles.paddingBottom = node.padding.bottom;
        styles.paddingLeft = node.padding.left;
      }
      const align = mapJustifyOrAlign(node.alignItems);
      if (align) styles.alignItems = align;
      const justify = mapJustifyOrAlign(node.justifyContent);
      if (justify) styles.justifyContent = justify;
    }

    const primaryFill = node.fills?.find((f) => f.hex);
    if (primaryFill?.hex && node.type !== "TEXT") {
      styles.backgroundColor = primaryFill.hex;
    }

    if (node.cornerRadius !== undefined && node.cornerRadius > 0) {
      styles.borderTopLeftRadius = node.cornerRadius;
      styles.borderTopRightRadius = node.cornerRadius;
      styles.borderBottomRightRadius = node.cornerRadius;
      styles.borderBottomLeftRadius = node.cornerRadius;
    }

    const primaryStroke = node.strokes?.find((s) => s.hex);
    if (primaryStroke?.hex) {
      const w = primaryStroke.width ?? 1;
      styles.borderTopWidth = w;
      styles.borderRightWidth = w;
      styles.borderBottomWidth = w;
      styles.borderLeftWidth = w;
    }

    if (node.typography) {
      if (node.typography.fontFamily) {
        styles.fontFamily = node.typography.fontFamily;
      }
      if (typeof node.typography.fontSize === "number") {
        styles.fontSize = node.typography.fontSize;
      }
      const weightNum = mapFontWeightToNumber(node.typography.fontWeight);
      if (weightNum !== undefined) {
        styles.fontWeight = weightNum;
      }
      const lh = parseNumericLineHeight(node.typography.lineHeight, node.typography.fontSize);
      if (lh !== undefined) {
        styles.lineHeight = lh;
      }
      if (typeof node.typography.letterSpacing === "number") {
        styles.letterSpacing = node.typography.letterSpacing;
      }
      if (primaryFill?.hex) {
        styles.color = primaryFill.hex;
      }
    }

    const relRect = {
      x: node.rect.x - rootOrigin.x,
      y: node.rect.y - rootOrigin.y,
      width: node.rect.width,
      height: node.rect.height,
    };

    nodes.push({
      id: node.id,
      figmaId: node.id,
      selector: `[data-figma-id="${node.id}"]`,
      ...(node.typography?.textAlign === "RIGHT" ? { direction: "rtl" as const } : {}),
      rect: relRect,
      styles,
      ...(node.typography?.characters !== undefined ? { text: node.typography.characters } : {}),
      ...(node.codeConnect ? { codeConnect: node.codeConnect } : {}),
    });

    if (node.children) {
      for (const child of node.children) {
        visit(child, rootOrigin);
      }
    }
  }

  visit(root, { x: root.rect.x, y: root.rect.y });

  return {
    adapter: "figma",
    viewport: { width, height, deviceScaleFactor },
    nodes,
    ...(options.imagePath ? { imagePath: options.imagePath } : {}),
  };
}
