/**
 * Zero-dependency shared utility functions.
 * Kept strictly isolated from Zod or Node.js runtime code so browser/QuickJS
 * bundles (e.g. Figma plugin code.js) can import them without bloating.
 */

/**
 * Normalizes Figma URL node IDs ("5031-4449") into Plugin API format ("5031:4449").
 */
export function normalizeNodeId(id: string): string {
  const trimmed = id.trim();
  if (/^\d+-\d+$/.test(trimmed)) {
    return trimmed.replace("-", ":");
  }
  return trimmed;
}
