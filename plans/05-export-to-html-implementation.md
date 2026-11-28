# Execution Plan: Deterministic `export_to_html` (Figma → HTML/CSS)

> **Audience:** This plan is written to be executed step-by-step by a smaller/weaker coding model with **zero guesswork**. Follow the tasks in strict order (`Task 1` → `Task 6`). Do **not** skip verification commands, do **not** improvise extra abstractions, and do **not** modify files outside the listed scope.

---

## 0. Mandatory Repo Guardrails (Read Before Writing Any Code)

Violating any rule below will break `npm run typecheck`, `npm test`, or `npm run build`:

1. **Node 22 Strip-Only TypeScript Rules:**
   - Tests run directly on `.ts` files via `node --test` (TypeScript strip-only mode).
   - **FORBIDDEN:** `enum`, `namespace`, parameter properties (`constructor(public x: string)`).
   - **REQUIRED:** Include `.ts` extension on all relative imports (e.g. `import { handleExportToHtml } from "./html-exporter.ts";`).
   - **REQUIRED:** Use `import type { ... }` for type-only imports (`isolatedModules: true`).
2. **Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`):**
   - Array indexing (`arr[0]`) has type `T | undefined`. Always guard before reading properties.
3. **QuickJS Plugin Bundle Rules (`packages/plugin/src/`):**
   - `packages/plugin/scripts/build.mjs` compiles `code.ts` with `target: "es2017"`.
   - **FORBIDDEN in `packages/plugin/src/`:**
     - Any `node:*` imports (`node:fs`, `node:path`, `Buffer`).
     - Any value import from `@figcp/shared` (that pulls Zod into `dist/code.js`, bloating it by ~170 KB).
     - ES2018+ Unicode property regexes like `/\p{Script=Arabic}/u` (use explicit ranges `/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/` instead).
   - **ALLOWED in `packages/plugin/src/`:**
     - `import type { ExportHtmlParams, ExportHtmlResult } from "@figcp/shared";`
     - `import { normalizeNodeId } from "@figcp/shared/utils";`
4. **MCP Stdio Hygiene (`packages/server/src/`):**
   - **FORBIDDEN:** `console.log(...)` anywhere in `packages/server/src/`. An existing unit test fails immediately if `console.log` appears. Use `console.error(...)` only if logging is needed.
5. **Exact Current Tool Count (Correction to `plans/04-export-to-html.md`):**
   - The server currently exposes **8 MCP tools**. Adding `export_to_html` brings the total to **9 MCP tools** (NOT 5).

---

## 1. File Map (Exact Scope)

| Action | File Path | Purpose |
| :--- | :--- | :--- |
| Modify | `packages/shared/src/protocol.ts` | Add `"export_to_html"` RPC method + `ExportHtmlParamsSchema` + `ExportHtmlResultSchema` + TS types |
| Modify | `packages/shared/src/__tests__/protocol.test.ts` | Unit tests for `export_to_html` schemas and bounds validation |
| Create | `packages/plugin/src/html-exporter.ts` | Deterministic Figma SceneNode → HTML/CSS engine (`handleExportToHtml`) |
| Create | `packages/plugin/src/__tests__/html-exporter.test.ts` | Unit tests for layout overrides, absolute positioning, CSS vars, SVG/IMG assets, RTL/escaping, truncation |
| Modify | `packages/plugin/src/code.ts` | Dispatch `req.method === "export_to_html"` inside `executor.runTask(...)` |
| Modify | `packages/server/src/mcp.ts` | Register `export_to_html` MCP tool with Zod validation and >64 KB / `outputPath` spill-to-disk |
| Modify | `packages/server/src/__tests__/mcp-tools.test.ts` | Update tool list (9 tools), test `export_to_html` inline + spill-to-disk + `outputPath` + `ValidationError` |
| Modify | `tests/e2e/closed-loop.test.ts` | Add `export_to_html` E2E branch in `FakeFigmaPlugin` and call check |
| Modify | `packages/skills/figcp/SKILL.md` | Document `export_to_html` under Pipeline 2 ("Figma → Code") |
| Modify | `AGENTS.md` | Update MCP tool surface from 8 tools to 9 tools |

---

## Task 1 — Shared Protocol Schemas & Types (`packages/shared`)

### Step 1.1 (Red): Add Failing Tests in `packages/shared/src/__tests__/protocol.test.ts`

1. Open `packages/shared/src/__tests__/protocol.test.ts`.
2. Add `ExportHtmlParamsSchema`, `ExportHtmlResultSchema`, and `RpcMethodSchema` to the import list from `"../protocol.ts"`.
3. Add a new `it(...)` block inside `describe("@figcp/shared protocol", ...)`:

```ts
  it("validates export_to_html RPC method, params defaults, bounds, and result schema", () => {
    assert.equal(RpcMethodSchema.parse("export_to_html"), "export_to_html");

    const defaults = ExportHtmlParamsSchema.parse({});
    assert.deepEqual(defaults, {
      mode: "standalone",
      useCssVars: true,
      inlineSvgs: true,
      inlineImages: false,
      maxDepth: 8,
      maxNodes: 400,
    });

    assert.throws(() => ExportHtmlParamsSchema.parse({ maxDepth: 16 }));
    assert.throws(() => ExportHtmlParamsSchema.parse({ maxDepth: -1 }));
    assert.throws(() => ExportHtmlParamsSchema.parse({ maxNodes: 2001 }));
    assert.throws(() => ExportHtmlParamsSchema.parse({ maxNodes: 0 }));

    const result = ExportHtmlResultSchema.parse({
      html: "<div>Hello</div>",
      css: ".n1 { color: #000; }",
      cssVariables: { "--surface-card": "#ffffff" },
      stats: { nodeCount: 1, svgCount: 0, imageCount: 0, truncated: false },
      warnings: [],
    });
    assert.equal(result.stats.nodeCount, 1);
  });
```

4. Run `node --test packages/shared/src/__tests__/protocol.test.ts` and confirm it **fails**.

### Step 1.2 (Green): Implement Schemas in `packages/shared/src/protocol.ts`

1. In `packages/shared/src/protocol.ts`, add `"export_to_html"` to `RpcMethodSchema` (lines 3–12):
   ```ts
   export const RpcMethodSchema = z.enum([
     "ping",
     "run_figma_js",
     "inspect_design_system",
     "inspect_node_bounds",
     "figma_undo",
     "figma_status",
     "get_design_context",
     "export_node_assets",
     "export_to_html",
   ]);
   ```
2. Near the bottom of `packages/shared/src/protocol.ts` (above `export { normalizeNodeId } from "./utils.ts";`), add:
   ```ts
   export const ExportHtmlParamsSchema = z.object({
     nodeId: z.string().min(1).optional(),
     mode: z.enum(["standalone", "fragment"]).default("standalone"),
     useCssVars: z.boolean().default(true),
     inlineSvgs: z.boolean().default(true),
     inlineImages: z.boolean().default(false),
     maxDepth: z.number().int().min(0).max(15).default(8),
     maxNodes: z.number().int().min(1).max(2000).default(400),
   });

   export type ExportHtmlParams = z.input<typeof ExportHtmlParamsSchema>;
   export type ExportHtmlResolvedParams = z.output<typeof ExportHtmlParamsSchema>;

   export const ExportHtmlResultSchema = z.object({
     html: z.string(),
     css: z.string(),
     cssVariables: z.record(z.string()),
     stats: z.object({
       nodeCount: z.number().int().nonnegative(),
       svgCount: z.number().int().nonnegative(),
       imageCount: z.number().int().nonnegative(),
       truncated: z.boolean(),
     }),
     warnings: z.array(z.string()),
   });

   export type ExportHtmlResult = z.infer<typeof ExportHtmlResultSchema>;
   ```
   *(Note: `packages/shared/src/index.ts` already does `export * from "./protocol.ts";`, so no edits to `index.ts` are required.)*

### Step 1.3 (Verify Task 1)
Run:
```bash
npm run typecheck && node --test packages/shared/src/__tests__/protocol.test.ts
```
Both must pass with exit code 0 before moving to Task 2.

---

## Task 2 — Plugin HTML/CSS Exporter Engine (`packages/plugin/src/html-exporter.ts`)

### Step 2.1 (Red): Create `packages/plugin/src/__tests__/html-exporter.test.ts`

Create `packages/plugin/src/__tests__/html-exporter.test.ts` testing all 7 required behaviors using plain mock Figma objects (no external deps):

1. **Test 1 — Auto Layout `FILL` / `HUG` overrides:**
   - Parent: `FRAME`, `layoutMode: "HORIZONTAL"`, `getCSSAsync()` returns `{ display: "flex", width: "400px", height: "60px" }`.
   - Child 1: `FRAME`, `layoutSizingHorizontal: "FILL"`, `layoutSizingVertical: "HUG"`, `getCSSAsync()` returns `{ width: "200px", height: "40px" }`.
   - Child 2: `FRAME`, `layoutSizingHorizontal: "HUG"`, `layoutSizingVertical: "FILL"`, `getCSSAsync()` returns `{ width: "80px", height: "40px" }`.
   - Assert Child 1 CSS has `flex: 1 0 0;`, `min-width: 0;`, `height: fit-content;` and does **not** have `width: 200px;` or `height: 40px;`.
   - Assert Child 2 CSS has `width: fit-content;`, `height: 100%;` and does **not** have `width: 80px;` or `height: 40px;`.
2. **Test 2 — `ABSOLUTE` positioning inside Auto Layout:**
   - Parent: `FRAME`, `layoutMode: "HORIZONTAL"`, `absoluteBoundingBox: { x: 100, y: 200, width: 300, height: 80 }`.
   - Child: `FRAME`, `layoutPositioning: "ABSOLUTE"`, `absoluteBoundingBox: { x: 120, y: 210, width: 16, height: 16 }`.
   - Assert Parent CSS contains `position: relative;`.
   - Assert Child CSS contains `position: absolute;`, `left: 20px;`, `top: 10px;`.
3. **Test 3 — Bound Variable (Direct + Semantic Alias Chain) → `:root` CSS Custom Property (`useCssVars: true`):**
   - Mock `figma.variables.getVariableByIdAsync`:
     - `"var_base_white"` → `{ id: "var_base_white", name: "primitive/white", resolvedType: "COLOR", valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } } }`.
     - `"var_card"` → `{ id: "var_card", name: "surface/card", resolvedType: "COLOR", valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "var_base_white" } } }`.
   - Node: `FRAME` with `fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, visible: true }]`, `boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "var_card" }] }`, `getCSSAsync()` returning `{ background: "#FFFFFF" }`.
   - Assert `result.cssVariables["--surface-card"] === "#ffffff"` (proves semantic `VARIABLE_ALIAS` chain was resolved!).
   - Assert `result.css` contains `:root {`, `--surface-card: #ffffff;`, and `var(--surface-card, #ffffff)`.
   - Also verify `getVariableByIdAsync("var_card")` was called only **once** when two nodes bind the same `"var_card"` (proves variable cache works).
4. **Test 4 — `isAsset: true` SVG embedding (`inlineSvgs: true`):**
   - Node: `FRAME`, `isAsset: true`, has a child `VECTOR`, `exportAsync({ format: "SVG_STRING" })` returns `'<?xml version="1.0"?><svg viewBox="0 0 16 16"><path d="M0 0"/></svg>'`.
   - Assert `result.html` contains `<svg viewBox="0 0 16 16"><path d="M0 0"/></svg>` and does **not** contain `<?xml`.
   - Assert wrapper CSS contains `display: inline-flex;` and `flex-shrink: 0;`.
   - Assert `result.stats.svgCount === 1` and child `VECTOR` was **not** recursed (`result.stats.nodeCount` counts asset as 1 node).
5. **Test 5 — `IMAGE` fill handling (`inlineImages: false` vs `inlineImages: true`):**
   - Node: `RECTANGLE` with `fills: [{ type: "IMAGE", visible: true, imageHash: "abc" }]`, `exportAsync({ format: "PNG", ... })` returns `new Uint8Array([137, 80, 78, 71])`.
   - With `inlineImages: false`: assert `result.stats.imageCount === 1`, `result.warnings.length > 0`, and HTML contains a placeholder element (no `data:image/png;base64,`).
   - With `inlineImages: true`: assert `result.stats.imageCount === 1` and HTML/CSS contains `data:image/png;base64,iVBORw==`.
6. **Test 6 — Persian/RTL, HTML Escaping, Newlines & Styled Text Segments:**
   - Node: `TEXT`, `characters: 'سلام <script>&"test"\nخط دوم'`, `getStyledTextSegments` returns 2 segments: `{ characters: "سلام ", fontName: { family: "IRANSansXFaNum", style: "Bold" }, fontSize: 16, fills: [] }` and `{ characters: '<script>&"test"\nخط دوم', fontName: { family: "IRANSansXFaNum", style: "Regular Italic" }, fontSize: 14, fills: [] }`.
   - Assert `result.html` contains `dir="rtl"`, `&lt;script&gt;&amp;&quot;test&quot;<br />`, does **not** contain raw `<script>`, and renders `<span` with `font-weight: 700` and `font-style: italic`.
   - Assert `result.css` sets `margin: 0;` on text node `<p>` (and standalone `<style>` includes `body, p { margin: 0; }`).
   - In `mode: "standalone"`, assert `result.html` starts with `<!DOCTYPE html>` and `<html lang="fa" dir="rtl">`.
   - In `mode: "fragment"`, assert `result.html` does **not** contain `<!DOCTYPE html>`.
7. **Test 7 — Invisible Nodes Skipped & `maxNodes` Truncation:**
   - Parent with 1 invisible child (`visible: false`) and 5 visible children; run with `maxNodes: 3`.
   - Assert invisible child is absent from HTML.
   - Assert `result.stats.truncated === true` and `result.warnings.some((w) => w.includes("maxNodes"))`.

Run `node --test packages/plugin/src/__tests__/html-exporter.test.ts` and confirm it **fails** (module does not exist yet).

### Step 2.2 (Green): Implement `packages/plugin/src/html-exporter.ts`

Create `packages/plugin/src/html-exporter.ts`. Follow these **exact** rules and helper specifications:

#### Imports (CRITICAL — No Zod, No Node Built-ins)
```ts
import type { ExportHtmlParams, ExportHtmlResult } from "@figcp/shared";
import { normalizeNodeId } from "@figcp/shared/utils";
```

#### Exact Pure Helpers to Implement
1. **`escapeHtml(input: string): string`**:
   Replace `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&#39;`.
2. **`hasRtlChars(text: string): boolean`**:
   Use ES2017-safe regex: `/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)`.
3. **`toCssVarName(figmaName: string): string`**:
   ```ts
   const slug = figmaName
     .trim()
     .toLowerCase()
     .replace(/[^a-z0-9]+/g, "-")
     .replace(/^-+|-+$/g, "");
   return `--${slug || "token"}`;
   ```
4. **`formatRgbColor(color: { r: number; g: number; b: number; a?: number }): string`**:
   Convert `r/g/b` (`0..1`) to 2-digit lowercase hex `#rrggbb`. If `color.a !== undefined && color.a < 1`, append 2-digit alpha hex (`Math.round(color.a * 255)`).
5. **`uint8ToBase64(bytes: Uint8Array): string` & `uint8ArrayToUtf8(bytes: Uint8Array): string`**:
   Copy the exact QuickJS-safe implementations from `packages/plugin/src/inspectors.ts` (lines 25–54) — do NOT use Node's `Buffer`.
6. **`stripXmlHeader(svg: string): string`**:
   ```ts
   return svg
     .replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, "")
     .replace(/^\s*<!DOCTYPE[\s\S]*?>\s*/i, "")
     .trim();
   ```
7. **`sanitizeClassName(name: string, index: number): string`**:
   Produce a deterministic, valid CSS class name:
   ```ts
   const slug = name
     .trim()
     .toLowerCase()
     .replace(/[^a-z0-9_-]+/g, "-")
     .replace(/^-+|-+$/g, "")
     .slice(0, 32);
   return slug ? `fg-${slug}-${index}` : `fg-node-${index}`;
   ```
8. **`isVectorOnlyIcon(node: SceneNode): boolean`**:
   - Return `true` if `"isAsset" in node && (node as { isAsset?: boolean }).isAsset === true`.
   - Vector primitive types: `const VECTOR_TYPES = new Set(["VECTOR", "STAR", "LINE", "ELLIPSE", "POLYGON", "BOOLEAN_OPERATION"]);`
   - If `VECTOR_TYPES.has(node.type)` and node does not have a visible `IMAGE` fill, return `true`.
   - If `"children" in node && Array.isArray(node.children)`:
     - Filter visible children (`c.visible !== false`).
     - If `visibleChildren.length === 0`, return `false`.
     - Return `true` only if **no** visible descendant is `TEXT` or has a visible `IMAGE` fill, AND every leaf descendant is in `VECTOR_TYPES`. (Guard with a small recursion cap of 6 levels.)
9. **`hasVisibleImageFill(node: SceneNode): boolean`**:
   Check `"fills" in node && Array.isArray(node.fills)` and return `node.fills.some((p) => p && typeof p === "object" && p.type === "IMAGE" && p.visible !== false && (p.opacity === undefined || p.opacity > 0))`.
10. **`resolveTargetNode(figmaApi: PluginAPI, nodeId?: string): Promise<SceneNode>`**:
    - If `nodeId` provided: `const normalized = normalizeNodeId(nodeId); const found = await figmaApi.getNodeByIdAsync(normalized);`
    - Throw if `!found || found.type === "DOCUMENT" || found.type === "PAGE"`.
    - Else: `const target = figmaApi.currentPage.selection[0] ?? null;`; throw `"No nodeId provided and nothing is currently selected in Figma."` if null.
11. **`getCachedVariable(figmaApi, varId, varCache): Promise<Variable | null>` & `resolveBoundVariable(figmaApi, aliasId, varCache, cssVariables): Promise<{ varName: string; fallback: string | null } | null>`**:
    - `getCachedVariable`: check `varCache.has(varId)` first (`Map<string, Variable | null>`); on miss call `figmaApi.variables?.getVariableByIdAsync?.(varId)` inside `try/catch`, store result (or `null`) in `varCache`, and return it.
    - In `resolveBoundVariable`:
      - Fetch root `variable = await getCachedVariable(figmaApi, aliasId, varCache)`. If null, return `null`.
      - Compute `varName = toCssVarName(variable.name)`.
      - **Follow semantic `VARIABLE_ALIAS` chains** (max 5 hops, guarded by `visited = new Set<string>([aliasId])`):
        ```ts
        let currentVar: Variable | null = variable;
        let terminalVal: unknown = undefined;
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
        ```
      - Convert `terminalVal` to `fallback`:
        - If object with `r, g, b`: `fallback = formatRgbColor(terminalVal)`.
        - If number: `fallback = `${terminalVal}px``.
        - If string: `fallback = terminalVal`.
        - Otherwise `fallback = null`.
      - If `fallback !== null && !(varName in cssVariables)`, record `cssVariables[varName] = fallback`.
      - Return `{ varName, fallback }`.
12. **`extractAliasId(raw: unknown): string | null`**:
    - If `Array.isArray(raw)` → recurse on `raw[0]`.
    - If `raw && typeof raw === "object" && "id" in raw && typeof (raw as { id?: unknown }).id === "string"` → return `(raw as { id: string }).id`.
    - Return `null`.
13. **`applyVariableBindings(cssMap, node, figmaApi, varCache, cssVariables): Promise<void>`**:
    Read `const bv = (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables;`
    - **Fills:** Check `extractAliasId(bv?.fills)` OR first visible `SOLID` paint's `extractAliasId(paint.boundVariables?.color)`.
      - If resolved to `{ varName, fallback }`:
        - Determine fallback: `fallback ?? cssMap["background"] ?? cssMap["background-color"] ?? cssMap["color"] ?? "inherit"`.
        - Value: `var(${varName}, ${effectiveFallback})`.
        - If `node.type === "TEXT"` → `cssMap["color"] = value`.
        - Else → delete `cssMap["background"]`; `cssMap["background-color"] = value`.
    - **Strokes:** Check `extractAliasId(bv?.strokes)` OR first visible `SOLID` stroke's `extractAliasId(stroke.boundVariables?.color)`.
      - If resolved → `cssMap["border-color"] = `var(${varName}, ${fallback ?? "currentColor"})``.
    - **Scalar fields mapping:**
      ```ts
      const SCALAR_MAP: Array<[string, string]> = [
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
      ```
      For each `[figmaField, cssProp]`: if `extractAliasId(bv?.[figmaField])` resolves to `{ varName, fallback }`, set `cssMap[cssProp] = fallback ? `var(${varName}, ${fallback})` : `var(${varName})``.
14. **`applyLayoutSizingOverrides(cssMap, node, parentLayoutMode): void`**:
    Read `layoutSizingHorizontal` and `layoutSizingVertical` safely from `node as Record<string, unknown>`:
    - If `layoutSizingHorizontal === "FILL"`:
      - `delete cssMap["width"];`
      - If `parentLayoutMode === "HORIZONTAL"`: `cssMap["flex"] = "1 0 0"; cssMap["min-width"] = "0";`
      - Else: `cssMap["width"] = "100%";`
    - Else if `layoutSizingHorizontal === "HUG"`:
      - `cssMap["width"] = "fit-content";`
    - If `layoutSizingVertical === "FILL"`:
      - `delete cssMap["height"];`
      - If `parentLayoutMode === "VERTICAL"`: `cssMap["flex"] = "1 0 0"; cssMap["min-height"] = "0";`
      - Else: `cssMap["height"] = "100%";`
    - Else if `layoutSizingVertical === "HUG"`:
      - `cssMap["height"] = "fit-content";`
15. **`applyPositioningOverrides(cssMap, node, parentNode, isRoot, hasAbsoluteChild): void`**:
    - Read `nodeLayoutMode = (node as Record<string, unknown>).layoutMode as string | undefined`.
    - If `hasAbsoluteChild || nodeLayoutMode === "NONE"`:
      - `cssMap["position"] = "relative";`
    - If `!isRoot && parentNode`:
      - Read `parentLayoutMode = (parentNode as Record<string, unknown>).layoutMode as string | undefined`.
      - Read `nodePositioning = (node as Record<string, unknown>).layoutPositioning as string | undefined`.
      - If `nodePositioning === "ABSOLUTE" || parentLayoutMode === "NONE" || !parentLayoutMode`:
        - `cssMap["position"] = "absolute";`
        - Read `childBox = (node as Record<string, unknown>).absoluteBoundingBox as { x: number; y: number } | null | undefined`.
        - Read `parentBox = (parentNode as Record<string, unknown>).absoluteBoundingBox as { x: number; y: number } | null | undefined`.
        - If `childBox && parentBox`:
          - `cssMap["left"] = `${Math.round(childBox.x - parentBox.x)}px`;`
          - `cssMap["top"] = `${Math.round(childBox.y - parentBox.y)}px`;`
16. **`mapFontStyleToCss(style?: string): { fontWeight?: number; fontStyle?: "italic" }` & `renderTextContent(node: TextNode): { innerHtml: string; isRtl: boolean }`**:
    - `mapFontStyleToCss(style)`:
      ```ts
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
      ```
    - Full text `rawText = typeof node.characters === "string" ? node.characters : ""`.
    - `isRtl = hasRtlChars(rawText)`.
    - Helper `formatEscapedText = (t: string) => escapeHtml(t).replace(/\r?\n/g, "<br />")`.
    - Try `getStyledTextSegments`:
      - Check `typeof (node as unknown as { getStyledTextSegments?: unknown }).getStyledTextSegments === "function"`.
      - Call `getStyledTextSegments(["fontName", "fontSize", "fills", "textDecoration"])`.
      - If array with `length > 1`:
        - Render each segment as `<span style="...">${formatEscapedText(seg.characters)}</span>` where inline style includes:
          - `font-family: '${escapeHtml(seg.fontName.family)}'` (if `seg.fontName?.family`),
          - `font-weight: ${weight}` and `font-style: italic` from `mapFontStyleToCss(seg.fontName?.style)`,
          - `font-size: ${seg.fontSize}px` (if `typeof seg.fontSize === "number"`),
          - `color: ${hex}` (if first visible solid fill exists),
          - `text-decoration: underline` / `line-through` (if `UNDERLINE` / `STRIKETHROUGH`).
        - Return `{ innerHtml: spans.join(""), isRtl }`.
    - Fallback: return `{ innerHtml: formatEscapedText(rawText), isRtl }`.
17. **Main Recursive Traversal (`visitNode`) inside `handleExportToHtml(figmaApi: PluginAPI, params: ExportHtmlParams = {}): Promise<ExportHtmlResult>`**:
    - Resolve defaults explicitly (do NOT import Zod in plugin!):
      ```ts
      const mode = params.mode === "fragment" ? "fragment" : "standalone";
      const useCssVars = params.useCssVars !== false;
      const inlineSvgs = params.inlineSvgs !== false;
      const inlineImages = params.inlineImages === true;
      const maxDepth = typeof params.maxDepth === "number" ? Math.max(0, Math.min(15, Math.floor(params.maxDepth))) : 8;
      const maxNodes = typeof params.maxNodes === "number" ? Math.max(1, Math.min(2000, Math.floor(params.maxNodes))) : 400;
      ```
    - Track state: `stats = { nodeCount: 0, svgCount: 0, imageCount: 0, truncated: false }`, `warnings: string[] = []`, `cssRules: string[] = []`, `cssVariables: Record<string, string> = {}`, `varCache = new Map<string, Variable | null>()`, `rtlTextCount = 0`, `totalTextCount = 0`.
    - Inside `visitNode(node, parentNode, depth)`:
      1. If `"visible" in node && node.visible === false` → return `""`.
      2. If `stats.nodeCount >= maxNodes`:
         - If `!stats.truncated`, set `stats.truncated = true` and push warning `` `Export truncated at maxNodes (${maxNodes}). Increase maxNodes or export a smaller child nodeId.` ``.
         - Return `""`.
      3. Increment `stats.nodeCount++`; assign `className = sanitizeClassName(node.name || node.type, stats.nodeCount)`.
      4. Build `cssMap: Record<string, string> = {}`:
         - If `typeof (node as unknown as { getCSSAsync?: unknown }).getCSSAsync === "function"`, copy `await node.getCSSAsync()` into `cssMap` (wrapped in `try/catch`).
      5. Check children visibility & absolute children:
         - `visibleChildren = "children" in node && Array.isArray(node.children) ? (node.children as SceneNode[]).filter((c) => c.visible !== false) : []`.
         - `hasAbsoluteChild = visibleChildren.some((c) => (c as unknown as { layoutPositioning?: string }).layoutPositioning === "ABSOLUTE")`.
      6. Apply overrides in order:
         - `applyLayoutSizingOverrides(cssMap, node, parentLayoutMode)`.
         - `applyPositioningOverrides(cssMap, node, parentNode, depth === 0, hasAbsoluteChild)`.
         - If `useCssVars`, `await applyVariableBindings(cssMap, node, figmaApi, varCache, cssVariables)`.
      7. **Asset Branch 1 — Inline SVG (`inlineSvgs && isVectorOnlyIcon(node)`):**
         - Export SVG string via `exportAsync({ format: "SVG_STRING" })` with fallback to `exportAsync({ format: "SVG" })` → `uint8ArrayToUtf8` → `stripXmlHeader`.
         - Increment `stats.svgCount++`.
         - Set flex-safe wrapper styles on `cssMap`: `cssMap["display"] = "inline-flex"; cssMap["align-items"] = "center"; cssMap["justify-content"] = "center"; cssMap["flex-shrink"] = "0";` (keeping only positioning, sizing, and these flex-safe props so icons never squash inside horizontal Flexbox).
         - Push CSS rule for `.${className}`.
         - Return `<span class="${className}" data-figma-id="${escapeHtml(node.id)}">${svgString}</span>`.
         - Do **NOT** recurse into children.
      8. **Asset Branch 2 — Image Fill (`hasVisibleImageFill(node)`):**
         - Increment `stats.imageCount++`.
         - If `inlineImages`:
           - Export PNG via `node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } })`, encode via `uint8ToBase64`, set `cssMap["background-image"] = `url("data:image/png;base64,${b64}")``, `cssMap["background-size"] = "cover"`, `cssMap["background-position"] = "center"`.
         - Else:
           - Push warning `` `Image fill on "${node.name}" (${node.id}) replaced with placeholder (set inlineImages: true to embed base64 PNG).` ``.
           - Set `cssMap["background-color"] = cssMap["background-color"] ?? "#e2e8f0"`.
      9. **Text Node Branch (`node.type === "TEXT"`):**
         - Call `renderTextContent(node as TextNode)`.
         - Increment `totalTextCount++`; if `isRtl`, increment `rtlTextCount++`.
         - Ensure `cssMap["margin"] = cssMap["margin"] ?? "0";` so `<p>` never gets default browser vertical margins (in both `standalone` and `fragment` modes).
         - Push CSS rule `.${className} { ... }`.
         - Return `<p class="${className}" data-figma-id="${escapeHtml(node.id)}"${isRtl ? ' dir="rtl"' : ""}>${innerHtml}</p>`.
      10. **Container / Leaf Branch:**
          - Push CSS rule `.${className} { ... }`.
          - If `visibleChildren.length > 0 && depth >= maxDepth`:
            - Set `stats.truncated = true`; push warning `` `Subtree of "${node.name}" (${node.id}) truncated at maxDepth (${maxDepth}).` ``.
          - Else recurse on each `child` in `visibleChildren` and join child HTML strings.
          - Return `<div class="${className}" data-figma-id="${escapeHtml(node.id)}">${childrenHtml}</div>`.
    - Assemble final CSS:
      - If `Object.keys(cssVariables).length > 0`, prepend `:root {\n  --key: val;\n}\n\n` before `cssRules.join("\n\n")`.
    - Assemble final HTML:
      - `isRtlRoot = totalTextCount > 0 && rtlTextCount >= totalTextCount / 2`.
      - If `mode === "fragment"`, `html = bodyHtml`.
      - If `mode === "standalone"`:
        ```ts
        const htmlAttrs = isRtlRoot ? 'lang="fa" dir="rtl"' : 'lang="en"';
        html = [
          "<!DOCTYPE html>",
          `<html ${htmlAttrs}>`,
          "<head>",
          '  <meta charset="UTF-8" />',
          '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
          `  <title>${escapeHtml(target.name || "Figma Export")}</title>`,
          "  <style>",
          "*, *::before, *::after { box-sizing: border-box; }",
          "body, p { margin: 0; }",
          css,
          "  </style>",
          "</head>",
          "<body>",
          bodyHtml,
          "</body>",
          "</html>",
        ].join("\n");
        ```

### Step 2.3 (Verify Task 2)
Run:
```bash
npm run typecheck && node --test packages/plugin/src/__tests__/html-exporter.test.ts
```
All 7 tests must pass with exit code 0 before moving to Task 3.

---

## Task 3 — Wire `export_to_html` into Plugin Worker (`packages/plugin/src/code.ts`)

### Step 3.1: Edit `packages/plugin/src/code.ts`

1. At top imports (around line 13), add:
   ```ts
   import { handleExportToHtml } from "./html-exporter.ts";
   ```
2. Inside the `try { ... } finally { isAgentCommandRunning = false; ... }` block right after the `if (req.method === "export_node_assets")` block (around line 303), add:
   ```ts
      if (req.method === "export_to_html") {
        const result = await executor.runTask(() =>
          handleExportToHtml(figma, {
            nodeId: typeof params.nodeId === "string" ? params.nodeId : undefined,
            mode: params.mode === "fragment" ? "fragment" : "standalone",
            useCssVars: typeof params.useCssVars === "boolean" ? params.useCssVars : undefined,
            inlineSvgs: typeof params.inlineSvgs === "boolean" ? params.inlineSvgs : undefined,
            inlineImages: typeof params.inlineImages === "boolean" ? params.inlineImages : undefined,
            maxDepth: typeof params.maxDepth === "number" ? params.maxDepth : undefined,
            maxNodes: typeof params.maxNodes === "number" ? params.maxNodes : undefined,
          }),
        );
        figma.ui.postMessage({
          type: "rpc_response",
          id: req.id,
          ok: true,
          result,
          logs: [],
          durationMs: Date.now() - startedAt,
        } satisfies RpcResponse);
        return;
      }
   ```

### Step 3.2 (Verify Task 3 — Including Bundle Size Check)
Run:
```bash
npm run typecheck && npm run build:plugin && ls -lh packages/plugin/dist/code.js
```
Confirm:
- `build:plugin` succeeds cleanly with ES2017 target.
- `packages/plugin/dist/code.js` is **under 55 KB** (if it jumps to >150 KB, you accidentally value-imported Zod from `@figcp/shared` — fix the import!).

---

## Task 4 — Expose `export_to_html` MCP Tool + Spill-to-Disk Guard (`packages/server/src/mcp.ts`)

### Step 4.1 (Red): Update Tests First

1. **In `packages/server/src/__tests__/mcp-tools.test.ts`:**
   - Update the tool list assertion (around lines 140–150) to expect **9 tools** in alphabetical order:
     ```ts
      assert.deepEqual(names, [
        "export_node_assets",
        "export_to_html",
        "figma_status",
        "figma_undo",
        "get_design_context",
        "import_web_to_figma",
        "inspect_design_system",
        "inspect_node_bounds",
        "run_figma_js",
      ]);
     ```
   - In the `onCommand` handler of that test, add a branch for `req.method === "export_to_html"` that returns a valid `ExportHtmlResult` and records `req.params.nodeId` to assert dash-to-colon normalization (`"5031-4449"` → `"5031:4449"`).
   - Add a dedicated `it("spills large export_to_html output (>64 KB) and supports explicit outputPath", ...)` test verifying:
     1. Small HTML (< 64 KB, no `outputPath`) returns inline `{ html, css, cssVariables, stats, warnings }`.
     2. Large HTML (> 64 KB, no `outputPath`) writes to `<FIGCP_HOME>/exports/*.html` (use temp dir via `process.env.FIGCP_HOME` and clean up in `finally`) and returns `{ spilled: true, filePath, bytes, stats, warnings }` without returning the giant `html` inline.
     3. Large or `outputPath` export in `mode: "fragment"` includes `<style>\n${res.css}\n</style>\n` prepended inside the written `.html` file so CSS is never lost on spill/save.
     4. Explicit `outputPath` writes atomically to that exact path and returns `{ spilled: false, filePath, bytes, stats, warnings }`.
     5. Malformed plugin payload returns `isError: true` with `ValidationError`.

2. **In `tests/e2e/closed-loop.test.ts`:**
   - Add `case "export_to_html":` in `FakeFigmaPlugin`'s `onCommand` returning a valid `ExportHtmlResult`.
   - Call `client.callTool({ name: "export_to_html", arguments: { nodeId: "5031-4449" } })` and assert `isError` is false and `html` is present.

3. Run `node --test packages/server/src/__tests__/mcp-tools.test.ts` and confirm it **fails**.

### Step 4.2 (Green): Register `export_to_html` in `packages/server/src/mcp.ts`

1. Import `ExportHtmlResultSchema` from `@figcp/shared` and `dirname` from `"node:path"` (alongside `join, resolve, sep`) and `statSync` (or `lstatSync`, already imported) in `packages/server/src/mcp.ts`.
2. Register the 9th tool right before `return server;` in `createFigcpMcpServer`:
   - Tool name: `"export_to_html"`
   - Parameters:
     - `nodeId: z.string().optional().describe("Target node ID ('5031:4449' or '5031-4449'). Defaults to current selection.")`
     - `fileKey: z.string().optional().describe("Target Figma fileKey when multiple files are connected.")`
     - `mode: z.enum(["standalone", "fragment"]).optional().default("standalone").describe("'standalone' full HTML document or 'fragment' snippet.")`
     - `useCssVars: z.boolean().optional().default(true).describe("Emit :root CSS custom properties for bound Figma variables.")`
     - `inlineSvgs: z.boolean().optional().default(true).describe("Embed inline <svg> for vector/icon assets.")`
     - `inlineImages: z.boolean().optional().default(false).describe("Embed base64 PNG data URLs for IMAGE fills (default false to keep payload compact).")`
     - `maxDepth: z.number().int().min(0).max(15).optional().default(8).describe("Maximum DOM nesting depth (default 8).")`
     - `maxNodes: z.number().int().min(1).max(2000).optional().default(400).describe("Maximum nodes to export (default 400).")`
     - `outputPath: z.string().optional().describe("Optional .html file path to write exported HTML directly to disk.")`
   - Handler steps:
     1. Normalize `nodeId`: `const normalized = nodeId ? normalizeNodeId(nodeId) : undefined;`.
     2. Call `safeSendCommand(transport, { method: "export_to_html", params: { ...(normalized ? { nodeId: normalized } : {}), mode, useCssVars, inlineSvgs, inlineImages, maxDepth, maxNodes }, fileKey })`.
     3. If `!response.ok`, return `{ isError: true, content: [{ type: "text", text: JSON.stringify(response.error, null, 2) }] }`.
     4. Validate `const parsed = ExportHtmlResultSchema.safeParse(response.result);`. If `!parsed.success`, return `{ isError: true, content: [{ type: "text", text: JSON.stringify({ name: "ValidationError", message: ... }, null, 2) }] }`.
     5. Compute `const res = parsed.data;` and prepare file content & size:
        - `const fileContent = mode === "fragment" && res.css.trim().length > 0 ? `<style>\n${res.css}\n</style>\n${res.html}` : res.html;`
        - `const bytes = Buffer.byteLength(fileContent, "utf8");`
        - `const inlinePayloadBytes = Buffer.byteLength(res.html, "utf8") + Buffer.byteLength(res.css, "utf8");`
     6. **Spill-to-disk or explicit `outputPath`** (`if (outputPath || inlinePayloadBytes > 65_536)`):
        - Determine `destPath`:
          - If `outputPath`: `destPath = resolve(outputPath)`. If `existsSync(destPath) && lstatSync(destPath).isDirectory()`, return `{ isError: true, ... }` (`ValidationError`: path is a directory). Call `mkdirSync(dirname(destPath), { recursive: true })`.
          - Else: `const exportsDir = join(resolveFigcpHome(), "exports"); mkdirSync(exportsDir, { recursive: true }); const safeId = (normalized || "selection").replace(/[^a-zA-Z0-9_-]/g, "_"); destPath = join(exportsDir, `${safeId}-${Date.now()}-${randomBytes(3).toString("hex")}.html`);`.
        - Write `fileContent` atomically via temp file in `dirname(destPath)` (`writeFileSync(tmpPath, fileContent, { encoding: "utf8", mode: 0o600, flag: "wx" })` then `renameSync(tmpPath, destPath)`, cleaning up `tmpPath` on error).
        - Return JSON text:
          ```ts
          {
            spilled: !outputPath,
            filePath: destPath,
            bytes,
            stats: res.stats,
            warnings: res.warnings,
          }
          ```
     7. Otherwise return JSON text `{ html: res.html, css: res.css, cssVariables: res.cssVariables, stats: res.stats, warnings: res.warnings }`.

### Step 4.3 (Verify Task 4)
Run:
```bash
npm run typecheck && node --test packages/server/src/__tests__/mcp-tools.test.ts tests/e2e/closed-loop.test.ts
```
All tests (including stdout hygiene — zero `console.log`) must pass.

---

## Task 5 — Documentation Updates (`SKILL.md` & `AGENTS.md`)

1. **`packages/skills/figcp/SKILL.md`**:
   - Under `## 2. Pipeline 2: Figma → Code`, add a short subsection (`### Step 1b — Deterministic HTML/CSS Export (Zero-Token Preview & Reference)`) explaining:
     - Call `export_to_html` (with optional `nodeId`, defaults to current selection) to generate standalone HTML + CSS with `:root` CSS custom properties, inline `<svg>` icons, Auto Layout `FILL`/`HUG` overrides, and automatic `dir="rtl"` for Persian text.
     - Large outputs (>64 KB) or `outputPath` are written directly to disk to keep context small.
2. **`AGENTS.md`**:
   - In Section `## 4. MCP Tool Surface`, update `8 Focused Tools` → `9 Focused Tools` and add item `9. export_to_html`.

---

## Task 6 — Full Repository Verification

Run the complete verification command once all edits are done:
```bash
npm run typecheck && npm run build && npm test
```
Verify all of the following before finishing:
- [ ] `npm run typecheck` exits with `0` across all 4 packages (`shared`, `linter`, `plugin`, `server`).
- [ ] `npm run build` produces `packages/plugin/dist/code.js` (< 55 KB) and `packages/server/dist/index.js`.
- [ ] `npm test` passes **100%** of test suites with `0` failures and `0` skipped tests.
- [ ] `git diff --stat` contains **only** files listed in Section 1 (File Map).

---

## Optional Manual Smoke Test (Figma Desktop — Human Only, Not Automated)

1. Run `node packages/server/dist/index.js --setup` to copy the rebuilt `code.js` into `~/.figcp/plugin/`.
2. Reload `figcp` in Figma Desktop and test `export_to_html` on:
   - An RTL Persian component (`dir="rtl"`, inline `<svg>`, `var(--...)` variables).
   - A frame mixing `HUG` and `FILL` Auto Layout children plus an `ABSOLUTE` badge.
   - Open the exported `.html` file in a browser and compare visually with Figma.
