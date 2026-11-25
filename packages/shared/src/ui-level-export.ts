export interface UiLevelElement {
  figmaId: string;
  name: string;
  type: string;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  text?: string;
  codeConnect?: { file: string; export?: string };
  children?: UiLevelElement[];
}

export interface UiLevelNormalizedSpec {
  adapter: "figma";
  viewport: { width: number; height: number };
  elements: UiLevelElement[];
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
  codeConnect?: {
    file: string;
    export?: string;
  };
  children?: DesignContextNode[];
}

/**
 * Converts rich DesignContext tree into the offline NormalizedSpec format
 * natively consumed by `ui-level` (Gate 1 DOM geometry + computed styles).
 */
export function toUiLevelNormalizedSpec(
  root: DesignContextNode,
  viewportWidth?: number,
  viewportHeight?: number,
): UiLevelNormalizedSpec {
  const width = viewportWidth ?? (root.rect.width > 0 ? root.rect.width : 1440);
  const height = viewportHeight ?? (root.rect.height > 0 ? root.rect.height : 900);

  function convertNode(node: DesignContextNode, parentRect?: { x: number; y: number }): UiLevelElement {
    const computedStyles: Record<string, string> = {};

    // 1. Layout styles
    if (node.layoutMode && node.layoutMode !== "NONE") {
      computedStyles["display"] = "flex";
      computedStyles["flex-direction"] = node.layoutMode === "HORIZONTAL" ? "row" : "column";
      if (node.itemSpacing !== undefined && node.itemSpacing > 0) {
        computedStyles["gap"] = `${node.itemSpacing}px`;
      }
      if (node.padding) {
        computedStyles["padding"] = `${node.padding.top}px ${node.padding.right}px ${node.padding.bottom}px ${node.padding.left}px`;
      }
      if (node.alignItems) {
        computedStyles["align-items"] = node.alignItems.toLowerCase();
      }
      if (node.justifyContent) {
        computedStyles["justify-content"] = node.justifyContent.toLowerCase();
      }
    }

    // 2. Visual fills
    const primaryFill = node.fills?.find((f) => f.hex);
    if (primaryFill && primaryFill.hex) {
      computedStyles["background-color"] = primaryFill.hex;
    }

    // 3. Borders & Radii
    if (node.cornerRadius !== undefined && node.cornerRadius > 0) {
      computedStyles["border-radius"] = `${node.cornerRadius}px`;
    }
    const primaryStroke = node.strokes?.find((s) => s.hex);
    if (primaryStroke && primaryStroke.hex) {
      const w = primaryStroke.width ?? 1;
      computedStyles["border"] = `${w}px solid ${primaryStroke.hex}`;
    }

    // 4. Typography
    if (node.typography) {
      if (node.typography.fontFamily) {
        computedStyles["font-family"] = node.typography.fontFamily;
      }
      if (node.typography.fontSize) {
        computedStyles["font-size"] = `${node.typography.fontSize}px`;
      }
      if (node.typography.fontWeight) {
        computedStyles["font-weight"] = node.typography.fontWeight;
      }
      if (node.typography.textAlign) {
        computedStyles["text-align"] = node.typography.textAlign.toLowerCase();
      }
      if (primaryFill?.hex) {
        computedStyles["color"] = primaryFill.hex;
      }
    }

    const relativeRect = parentRect
      ? {
          x: node.rect.x - parentRect.x,
          y: node.rect.y - parentRect.y,
          width: node.rect.width,
          height: node.rect.height,
        }
      : {
          x: 0,
          y: 0,
          width: node.rect.width,
          height: node.rect.height,
        };

    const element: UiLevelElement = {
      figmaId: node.id,
      name: node.name,
      type: node.type,
      selector: `[data-figma-id="${node.id}"]`,
      rect: relativeRect,
      styles: computedStyles,
      text: node.typography?.characters,
      codeConnect: node.codeConnect,
    };

    if (node.children && node.children.length > 0) {
      element.children = node.children.map((c) => convertNode(c, node.rect));
    }

    return element;
  }

  return {
    adapter: "figma",
    viewport: { width, height },
    elements: [convertNode(root)],
  };
}
