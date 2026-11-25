import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CodeConnectMapping {
  file: string;
  export?: string;
  description?: string;
}

export type CodeConnectMap = Record<string, CodeConnectMapping>;

/**
 * Loads figcp.map.json from the current working directory or nearest ancestor.
 */
export function loadCodeConnectMap(startDir: string = process.cwd()): CodeConnectMap | null {
  let curr = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(curr, "figcp.map.json");
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(readFileSync(candidate, "utf8"));
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
          return raw as CodeConnectMap;
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

/**
 * Resolves a Figma component name against local Code Connect mappings.
 */
export function matchCodeConnect(
  map: CodeConnectMap | null,
  componentName?: string,
): CodeConnectMapping | undefined {
  if (!map || !componentName) return undefined;
  if (map[componentName]) return map[componentName];

  for (const [key, mapping] of Object.entries(map)) {
    if (
      componentName.endsWith(`/${key}`) ||
      key.endsWith(`/${componentName}`) ||
      componentName.toLowerCase() === key.toLowerCase()
    ) {
      return mapping;
    }
  }
  return undefined;
}
