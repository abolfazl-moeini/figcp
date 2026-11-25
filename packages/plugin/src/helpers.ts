export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface RgbaColor extends RgbColor {
  a: number;
}

export function hexToRgb(hex: string): RgbColor {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(clean)) {
    throw new Error(`Invalid hex color: "${hex}". Expected #RGB or #RRGGBB.`);
  }
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;

  return {
    r: parseInt(expanded.slice(0, 2), 16) / 255,
    g: parseInt(expanded.slice(2, 4), 16) / 255,
    b: parseInt(expanded.slice(4, 6), 16) / 255,
  };
}

export function hexToRgba(hex: string): RgbaColor {
  const clean = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{8}$/.test(clean)) {
    const rgb = hexToRgb(clean.slice(0, 6));
    return { ...rgb, a: parseInt(clean.slice(6, 8), 16) / 255 };
  }
  if (/^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(clean)) {
    return { ...hexToRgb(clean), a: 1 };
  }
  throw new Error(`Invalid hex color: "${hex}". Expected #RGB, #RRGGBB, or #RRGGBBAA.`);
}

export interface MinimalFigmaForHelpers {
  loadFontAsync(fontName: FontName): Promise<void>;
  listAvailableFontsAsync(): Promise<Array<{ fontName: FontName }>>;
  variables: {
    getLocalVariableCollectionsAsync(): Promise<Array<{ id: string; name: string }>>;
    getLocalVariablesAsync(): Promise<Array<{ id: string; name: string; variableCollectionId: string }>>;
    setBoundVariableForPaint(paint: SolidPaint, field: "color", variable: Variable | null): SolidPaint;
  };
  getLocalPaintStylesAsync?(): Promise<Array<{ id: string; name: string }>>;
  getLocalTextStylesAsync?(): Promise<Array<{ id: string; name: string }>>;
  getLocalEffectStylesAsync?(): Promise<Array<{ id: string; name: string }>>;
  currentPage: {
    selection: readonly SceneNode[];
    findOne?(predicate: (node: SceneNode) => boolean): SceneNode | null;
  };
  viewport: {
    scrollAndZoomIntoView(nodes: readonly BaseNode[]): void;
  };
}

export function createPluginHelpers(figmaApi: MinimalFigmaForHelpers) {
  return {
    hexToRgb,
    hexToRgba,

    async requireFont(fontName: FontName): Promise<void> {
      const available = await figmaApi.listAvailableFontsAsync();
      const familyMatches = available.filter(
        (f) => f.fontName.family.toLowerCase() === fontName.family.toLowerCase(),
      );
      if (familyMatches.length === 0) {
        throw new Error(
          `Font family "${fontName.family}" is not installed in Figma Desktop. Install the local OS font or choose an installed font.`,
        );
      }
      const exactMatch = familyMatches.find(
        (f) => f.fontName.style.toLowerCase() === fontName.style.toLowerCase(),
      );
      if (!exactMatch) {
        const availableStyles = familyMatches.map((f) => `"${f.fontName.style}"`).join(", ");
        throw new Error(
          `Font style "${fontName.style}" not found for family "${fontName.family}". Available installed styles: ${availableStyles}.`,
        );
      }
      await figmaApi.loadFontAsync(exactMatch.fontName);
    },

    async loadFontSafe(fontName: FontName): Promise<{ ok: true } | { ok: false; message: string; suggestions: FontName[] }> {
      try {
        await figmaApi.loadFontAsync(fontName);
        return { ok: true };
      } catch (err) {
        const available = await figmaApi.listAvailableFontsAsync();
        const familyLower = fontName.family.toLowerCase();
        const suggestions = available
          .filter((f) => f.fontName.family.toLowerCase().includes(familyLower.slice(0, 6)))
          .slice(0, 10)
          .map((f) => f.fontName);

        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          suggestions,
        };
      }
    },

    async setTextSafe(
      textNode: { fontName: FontName | typeof figma.mixed; characters: string },
      characters: string,
      fontName: FontName,
    ): Promise<void> {
      await figmaApi.loadFontAsync(fontName);
      textNode.fontName = fontName;
      textNode.characters = characters;
    },

    resizeFrameSafe(
      frame: {
        resize: (width: number, height: number) => void;
        layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
        primaryAxisSizingMode?: "FIXED" | "AUTO";
        counterAxisSizingMode?: "FIXED" | "AUTO";
      },
      width: number,
      height: number,
      sizing: { primary?: "FIXED" | "AUTO"; counter?: "FIXED" | "AUTO" } = {},
    ): void {
      // Always resize BEFORE applying sizing modes because Figma's resize() resets both to FIXED.
      frame.resize(width, height);
      // Guard against layoutMode NONE where setting sizing modes throws in Figma
      if (frame.layoutMode !== "NONE") {
        if (sizing.primary && "primaryAxisSizingMode" in frame) frame.primaryAxisSizingMode = sizing.primary;
        if (sizing.counter && "counterAxisSizingMode" in frame) frame.counterAxisSizingMode = sizing.counter;
      }
    },

    setAutoLayout(
      frame: {
        layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
        itemSpacing?: number;
        paddingTop?: number;
        paddingRight?: number;
        paddingBottom?: number;
        paddingLeft?: number;
        primaryAxisSizingMode?: "FIXED" | "AUTO";
        counterAxisSizingMode?: "FIXED" | "AUTO";
        primaryAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
        counterAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "BASELINE";
      },
      options: {
        direction?: "HORIZONTAL" | "VERTICAL";
        spacing?: number;
        padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
        primarySizing?: "FIXED" | "AUTO";
        counterSizing?: "FIXED" | "AUTO";
        primaryAlign?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
        counterAlign?: "MIN" | "CENTER" | "MAX" | "BASELINE";
      } = {},
    ): void {
      frame.layoutMode = options.direction ?? "HORIZONTAL";
      if (options.spacing !== undefined) frame.itemSpacing = options.spacing;
      if (typeof options.padding === "number") {
        frame.paddingTop = options.padding;
        frame.paddingRight = options.padding;
        frame.paddingBottom = options.padding;
        frame.paddingLeft = options.padding;
      } else if (options.padding && typeof options.padding === "object") {
        if (options.padding.top !== undefined) frame.paddingTop = options.padding.top;
        if (options.padding.right !== undefined) frame.paddingRight = options.padding.right;
        if (options.padding.bottom !== undefined) frame.paddingBottom = options.padding.bottom;
        if (options.padding.left !== undefined) frame.paddingLeft = options.padding.left;
      }
      if (options.primarySizing) frame.primaryAxisSizingMode = options.primarySizing;
      if (options.counterSizing) frame.counterAxisSizingMode = options.counterSizing;
      if (options.primaryAlign) frame.primaryAxisAlignItems = options.primaryAlign;
      if (options.counterAlign) frame.counterAxisAlignItems = options.counterAlign;
    },

    bindVariable(
      node: { setBoundVariable?: (field: string, variableId: string) => void },
      field: string,
      variable: { id: string } | string,
    ): void {
      const varId = typeof variable === "string" ? variable : variable.id;
      if (typeof node.setBoundVariable === "function") {
        node.setBoundVariable(field, varId);
      }
    },

    async findStyle(name: string, type: "paint" | "text" | "effect" = "paint") {
      if (type === "paint" && typeof figmaApi.getLocalPaintStylesAsync === "function") {
        const styles = await figmaApi.getLocalPaintStylesAsync();
        return styles.find((s) => s.name === name || s.name.endsWith(`/${name}`)) ?? null;
      }
      if (type === "text" && typeof figmaApi.getLocalTextStylesAsync === "function") {
        const styles = await figmaApi.getLocalTextStylesAsync();
        return styles.find((s) => s.name === name || s.name.endsWith(`/${name}`)) ?? null;
      }
      if (type === "effect" && typeof figmaApi.getLocalEffectStylesAsync === "function") {
        const styles = await figmaApi.getLocalEffectStylesAsync();
        return styles.find((s) => s.name === name || s.name.endsWith(`/${name}`)) ?? null;
      }
      return null;
    },

    async findComponent(name: string) {
      if (typeof figmaApi.currentPage.findOne === "function") {
        return (
          figmaApi.currentPage.findOne(
            (n) => (n.type === "COMPONENT" || n.type === "COMPONENT_SET") && (n.name === name || n.name.endsWith(`/${name}`)),
          ) ?? null
        );
      }
      return null;
    },

    makeBoundPaint(colorVar: Variable | null | undefined, fallbackHex = "#808080"): SolidPaint[] {
      const base: SolidPaint = { type: "SOLID", color: hexToRgb(fallbackHex) };
      if (!colorVar) return [base];
      return [figmaApi.variables.setBoundVariableForPaint(base, "color", colorVar)];
    },

    async findVariable(collectionHint: string | null, varName: string) {
      const [collections, allVars] = await Promise.all([
        figmaApi.variables.getLocalVariableCollectionsAsync(),
        figmaApi.variables.getLocalVariablesAsync(),
      ]);
      const col = collectionHint ? collections.find((c) => c.name.includes(collectionHint)) : undefined;
      const pool = col ? allVars.filter((v) => v.variableCollectionId === col.id) : allVars;
      return pool.find((v) => v.name === varName || v.name.endsWith(`/${varName}`)) ?? null;
    },

    reveal(nodes: readonly SceneNode[]): void {
      figmaApi.currentPage.selection = nodes;
      figmaApi.viewport.scrollAndZoomIntoView(nodes);
    },
  };
}
