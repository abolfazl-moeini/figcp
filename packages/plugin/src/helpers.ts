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
  currentPage: {
    selection: readonly SceneNode[];
  };
  viewport: {
    scrollAndZoomIntoView(nodes: readonly BaseNode[]): void;
  };
}

export function createPluginHelpers(figmaApi: MinimalFigmaForHelpers) {
  return {
    hexToRgb,
    hexToRgba,

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
        primaryAxisSizingMode: "FIXED" | "AUTO";
        counterAxisSizingMode: "FIXED" | "AUTO";
      },
      width: number,
      height: number,
      sizing: { primary?: "FIXED" | "AUTO"; counter?: "FIXED" | "AUTO" } = {},
    ): void {
      // Always resize BEFORE applying sizing modes because Figma's resize() resets both to FIXED.
      frame.resize(width, height);
      if (sizing.primary) frame.primaryAxisSizingMode = sizing.primary;
      if (sizing.counter) frame.counterAxisSizingMode = sizing.counter;
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
