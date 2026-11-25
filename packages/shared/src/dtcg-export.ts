import type { DesignSystemSnapshot } from "./protocol.ts";

export interface DtcgTokenGroup {
  [key: string]: DtcgToken | DtcgTokenGroup;
}

export interface DtcgToken {
  $type: string;
  $value: unknown;
  $description?: string;
}

/**
 * Converts Figma Local Variable Collections and Local Styles into standard
 * W3C Design Token Community Group (DTCG) format.
 * Compatible with Terrazzo, Style Dictionary, and Tailwind v4.
 */
export function toDtcgTokens(snapshot: DesignSystemSnapshot): DtcgTokenGroup {
  const root: DtcgTokenGroup = {};

  // Pre-index variable name -> collection key so alias references include their collection namespace
  const varCollectionByName = new Map<string, string>();
  for (const collection of snapshot.variableCollections) {
    const colKey = collection.name.replace(/\//g, ".");
    for (const v of collection.variables) {
      varCollectionByName.set(v.name.trim(), colKey);
    }
  }

  // 1. Variable Collections
  for (const collection of snapshot.variableCollections) {
    const colKey = collection.name.replace(/\//g, ".");
    const colGroup: DtcgTokenGroup = {};
    for (const v of collection.variables) {
      const parts = v.name.split("/").map((p) => p.trim());
      let cursor: DtcgTokenGroup = colGroup;

      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i]!;
        if (!cursor[seg] || typeof cursor[seg] !== "object") {
          cursor[seg] = {};
        }
        cursor = cursor[seg] as DtcgTokenGroup;
      }

      const leaf = parts[parts.length - 1]!;
      const primaryValue = Object.values(v.valuesByMode)[0];

      let type = "string";
      let val: unknown = primaryValue;

      if (v.resolvedType === "COLOR") {
        type = "color";
        if (typeof primaryValue === "string" && primaryValue.startsWith("{")) {
          // Format alias: "{border/focus -> blue/500} = \"#0000ff\"" -> "{Colors.border.focus}"
          const match = primaryValue.match(/\{([^}]+)\}/);
          if (match && match[1]) {
            const firstHop = match[1].split("->")[0]?.trim() ?? "";
            const targetCol = varCollectionByName.get(firstHop) ?? colKey;
            const aliasPath = firstHop.replace(/\//g, ".");
            val = `{${targetCol}.${aliasPath}}`;
          }
        }
      } else if (v.resolvedType === "FLOAT") {
        type = "dimension";
        val = typeof primaryValue === "number" ? `${primaryValue}px` : primaryValue;
      } else if (v.resolvedType === "BOOLEAN") {
        type = "boolean";
      }

      cursor[leaf] = {
        $type: type,
        $value: val,
      };
    }
    root[colKey] = colGroup;
  }

  // 2. Paint Styles
  if (snapshot.styles.paint.length > 0) {
    const paintGroup: DtcgTokenGroup = {};
    for (const p of snapshot.styles.paint) {
      if (p.hex) {
        paintGroup[p.name.replace(/\//g, ".")] = {
          $type: "color",
          $value: p.hex,
        };
      }
    }
    if (Object.keys(paintGroup).length > 0) {
      root["colorStyles"] = paintGroup;
    }
  }

  // 3. Text Styles
  if (snapshot.styles.text.length > 0) {
    const textGroup: DtcgTokenGroup = {};
    for (const t of snapshot.styles.text) {
      textGroup[t.name.replace(/\//g, ".")] = {
        $type: "typography",
        $value: {
          fontFamily: t.fontName?.family ?? "sans-serif",
          fontWeight: t.fontName?.style ?? "Regular",
          fontSize: t.fontSize ? `${t.fontSize}px` : "14px",
        },
      };
    }
    root["textStyles"] = textGroup;
  }

  // 4. Effect Styles
  if (snapshot.styles.effect.length > 0) {
    const effectGroup: DtcgTokenGroup = {};
    for (const e of snapshot.styles.effect) {
      if (e.colorHex || e.radius !== undefined) {
        effectGroup[e.name.replace(/\//g, ".")] = {
          $type: "shadow",
          $value: {
            color: e.colorHex ?? "#00000040",
            offsetX: `${e.offset?.x ?? 0}px`,
            offsetY: `${e.offset?.y ?? 2}px`,
            blur: `${e.radius ?? 4}px`,
            spread: "0px",
          },
        };
      }
    }
    if (Object.keys(effectGroup).length > 0) {
      root["effectStyles"] = effectGroup;
    }
  }

  return root;
}
