import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
  let curr = resolve(startDir);
  for (let i = 0; i < 10; i++) {
    const candidate = join(curr, "figcp.map.json");
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(readFileSync(candidate, "utf8"));
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
          const validated: CodeConnectMap = Object.create(null) as CodeConnectMap;
          for (const [name, value] of Object.entries(raw)) {
            if (!name || !value || typeof value !== "object" || Array.isArray(value)) continue;
            const entry = value as Record<string, unknown>;
            if (typeof entry.file !== "string" || !entry.file.trim()) continue;
            if (entry.export !== undefined && typeof entry.export !== "string") continue;
            if (entry.description !== undefined && typeof entry.description !== "string") continue;
            validated[name] = { file: entry.file, ...(entry.export ? { export: entry.export } : {}), ...(entry.description ? { description: entry.description } : {}) };
          }
          return validated;
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
  if (Object.hasOwn(map, componentName)) return map[componentName];

  const matches: CodeConnectMapping[] = [];
  for (const [key, mapping] of Object.entries(map)) {
    if (
      componentName.endsWith(`/${key}`) ||
      key.endsWith(`/${componentName}`) ||
      componentName.toLowerCase() === key.toLowerCase()
    ) {
      matches.push(mapping);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}
