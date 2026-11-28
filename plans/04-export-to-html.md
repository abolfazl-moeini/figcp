# Phase 4 Plan: Deterministic `export_to_html` (Figma → HTML/CSS) (TDD)

**Goal:** Add a fast, deterministic, zero-dependency **`export_to_html`** feature to `figcp` that converts any selected Figma node, component, or screen directly into clean HTML + CSS using Figma's native Plugin API (`node.getCSSAsync()`, `boundVariables`, `node.isAsset`, `exportAsync`)—working 100% on Figma Starter with local Persian/RTL fonts and zero external converter dependencies.

**Prerequisite:** Phases 1–3 pass (`npm run typecheck && npm test && npm run build`).

---

## 1. Design Decisions & Scope

- **Deterministic First (Zero AI Tokens for Translation):** The plugin converts the Figma Scene Graph directly into HTML + CSS in milliseconds. AI agents can either preview the standalone HTML immediately or use it as a high-precision structural reference when implementing React/Vue/Tailwind components.
- **Zero External Dependencies:** Runs cleanly inside Figma's QuickJS worker (`packages/plugin/dist/code.js`) without bundling third-party Figma-to-Code libraries.
- **Explicit Scope Boundaries:**
  - Best fidelity when designs use **Auto Layout** (`HORIZONTAL`/`VERTICAL`, `HUG`/`FILL`).
  - Non-Auto-Layout frames fall back to `position: relative` / `position: absolute` with bounding-box offsets.
  - Produces clean HTML/CSS + semantic `:root` CSS custom properties (`var(--...)`), not opinionated framework state logic.

---

## Task 4.1 — Shared Protocol Types (`packages/shared`)

### Red (Write Failing Tests First)
Update `packages/shared/src/__tests__/protocol.test.ts`:
- Test `RpcMethodSchema.parse("export_to_html")` succeeds.
- Test `ExportHtmlParamsSchema` defaults (`mode: "standalone"`, `useCssVars: true`, `inlineSvgs: true`, `inlineImages: false`, `maxDepth: 8`, `maxNodes: 400`).
- Test rejecting invalid `maxDepth > 15` or `maxNodes > 2000`.

### Green (Implement)
Update `packages/shared/src/protocol.ts`:
- Add `"export_to_html"` to `RpcMethodSchema`.
- Export `ExportHtmlParamsSchema`, `ExportHtmlParams`, and `ExportHtmlResult`:
  ```ts
  export interface ExportHtmlResult {
    html: string;
    css: string;
    cssVariables: Record<string, string>;
    stats: {
      nodeCount: number;
      svgCount: number;
      imageCount: number;
      truncated: boolean;
    };
    warnings: string[];
  }
  ```

### Verification
- `npm run typecheck` and `node --test packages/shared/src/__tests__/protocol.test.ts` pass.

---

## Task 4.2 — Plugin HTML/CSS Exporter Engine (`packages/plugin/src/html-exporter.ts`)

### Core Edge Cases to Handle Explicitly
1. **`getCSSAsync()` vs. `FILL` / `HUG` Auto Layout Sizing:**
   - Figma's `getCSSAsync()` often emits fixed pixel `width` / `height` even when `layoutSizingHorizontal === "FILL"` or `"HUG"`.
   - Override cleanly:
     - `layoutSizingHorizontal === "FILL"` → `width: 100%;` (or `flex: 1 0 0;` inside horizontal Auto Layout).
     - `layoutSizingHorizontal === "HUG"` → remove fixed `width` (`width: fit-content;`).
     - Same rule for `layoutSizingVertical` (`FILL` / `HUG`).
2. **Absolute Positioning Inside Auto Layout:**
   - If any child has `layoutPositioning === "ABSOLUTE"` (or parent has `layoutMode === "NONE"`), ensure parent gets `position: relative;` and child gets `position: absolute;` with `left`/`top` derived from `child.absoluteBoundingBox` relative to `parent.absoluteBoundingBox`.
3. **Variable Binding → CSS Custom Properties (`useCssVars: true`):**
   - Resolve `boundVariables` via a cached `Map<string, Variable>` (`figma.variables.getVariableByIdAsync` called once per unique variable ID to avoid QuickJS slowdown).
   - Convert variable names (e.g., `surface/card` → `--surface-card`) and emit `var(--surface-card, <fallback>)` plus a `:root { ... }` block.
4. **Assets (`node.isAsset` & `IMAGE` Fills):**
   - When `inlineSvgs: true` and (`node.isAsset === true` or vector-only icon frame without text children): call `node.exportAsync({ format: "SVG_STRING" })`, strip redundant outer XML headers, and embed inline `<svg>`.
   - When a node has a visible `IMAGE` fill: if `inlineImages: true`, export PNG via `exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } })` as `data:image/png;base64,...`; otherwise emit a lightweight placeholder with a warning so payload stays small.
5. **Rich Text & Persian/RTL Support:**
   - HTML-escape all text content (`&`, `<`, `>`, `"`, `'`) and convert `\n` to `<br />`.
   - Use `node.getStyledTextSegments(["fontName", "fontSize", "fills", "textDecoration"])` when available to render mixed-weight/color inline `<span>` segments.
   - Detect Persian/Arabic Unicode (`[\u0600-\u06FF]`) and automatically attach `dir="rtl"` on Persian text nodes (and on the root wrapper if the majority of text nodes are RTL).
6. **QuickJS Safety Guards:**
   - Skip nodes with `visible === false`.
   - Enforce `maxDepth` (default `8`) and `maxNodes` (default `400`); set `stats.truncated = true` and push a warning instead of freezing Figma on giant pages.

### Red (Write Failing Tests First)
Create `packages/plugin/src/__tests__/html-exporter.test.ts` with mock Figma nodes covering:
1. Auto Layout `HORIZONTAL` frame with `FILL`/`HUG` sizing overrides `getCSSAsync()` fixed widths cleanly.
2. Child with `layoutPositioning: "ABSOLUTE"` sets `position: relative` on parent and `position: absolute` with relative `left`/`top` on child.
3. Bound color variable generates `--surface-card` in `:root` and uses `var(--surface-card, ...)` in node CSS.
4. `isAsset: true` node invokes `exportAsync({ format: "SVG_STRING" })` and embeds `<svg>` instead of recursing into child vector paths.
5. Persian text node gets `dir="rtl"` and properly escapes `<script>` / `&` characters.
6. Invisible nodes are skipped and exceeding `maxNodes` sets `stats.truncated = true` with a warning.

### Green (Implement)
Create `packages/plugin/src/html-exporter.ts` implementing `handleExportToHtml(figmaApi, params)`.

### Verification
- `node --test packages/plugin/src/__tests__/html-exporter.test.ts` passes 100%.

---

## Task 4.3 — Wire into Plugin Worker (`packages/plugin/src/code.ts`)

### Steps
1. Import `handleExportToHtml` in `packages/plugin/src/code.ts`.
2. Add `if (req.method === "export_to_html")` branch dispatching to `handleExportToHtml(figma, req.params)` and returning `RpcResponse`.
3. Run `npm run build:plugin` to confirm ES2017 QuickJS bundle builds cleanly.

---

## Task 4.4 — Expose MCP Tool + Spill-to-Disk Guard (`packages/server/src/mcp.ts`)

### Red (Write Failing Tests First)
Update `packages/server/src/__tests__/mcp-tools.test.ts` and `tests/e2e/closed-loop.test.ts`:
1. Verify `tools/list` now includes `"export_to_html"` (5 tools total).
2. Verify `export_to_html` normalizes `nodeId` (`"5031-4449"` → `"5031:4449"`), forwards options to `FakeFigmaPlugin`, and returns HTML + CSS + stats.
3. Verify large-output protection: if generated HTML exceeds `64 kB` (or `outputPath` is explicitly provided), write the full HTML file to disk and return `{ filePath, bytes, stats, warnings }` instead of flooding the agent's context window.

### Green (Implement)
1. Register `export_to_html` in `packages/server/src/mcp.ts` with Zod schema (`nodeId`, `fileKey`, `mode`, `useCssVars`, `inlineSvgs`, `inlineImages`, `maxDepth`, `maxNodes`, `outputPath`).
2. Add spill-to-disk logic (`> 65_536` bytes → write to `outputPath` or `~/.figcp/exports/<nodeId>-<timestamp>.html`).
3. Update `packages/skills/figcp/SKILL.md` with a short "Figma → HTML/Code" section explaining when to call `export_to_html`.

### Verification
```bash
npm run typecheck
npm test
npm run build
```

---

## Task 4.5 — Live Figma Desktop Acceptance Checklist (macOS)

1. Run `node packages/server/dist/index.js --setup` to refresh `~/.figcp/plugin/code.js`.
2. Re-run the `figcp` plugin in Figma Desktop and test `export_to_html` on:
   - [ ] The 16-variant RTL **Search Box** component (verify `IRANSansXFaNum`, `dir="rtl"`, inline `<svg>` search/clear icons, and `var(--...)` CSS variables).
   - [ ] A frame mixing `HUG` and `FILL` Auto Layout children plus an `ABSOLUTE`-positioned badge.
   - [ ] Opening the exported standalone `.html` file in Safari/Chrome and comparing visually against Figma.
