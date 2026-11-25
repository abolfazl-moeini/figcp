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

  // 1. Variable Collections
  for (const collection of snapshot.variableCollections) {
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
          // Format alias: "{border/focus -> blue/500} = \"#0000ff\"" -> "{blue.500}"
          const match = primaryValue.match(/\{([^}]+)\}/);
          if (match && match[1]) {
            const aliasPath = match[1].split("->").pop()?.trim().replace(/\//g, ".") ?? "";
            val = `{${aliasPath}}`;
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
    root[collection.name.replace(/\//g, ".")] = colGroup;
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
    root["colorStyles"] = paintGroup;
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
          fontSize: t.fontSize ? `${t.fontSize}px` : undefined,
        },
      };
    }
    root["textStyles"] = textGroup;
  }

  return root;
}
