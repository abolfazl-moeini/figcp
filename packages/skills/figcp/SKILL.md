---
name: figcp-design-system
description: Closed-loop Design-System-First workflow for bidirectional Figma <-> Code authoring, RTL verification, Local Code Connect, and token export via figcp MCP on Figma Desktop.
---

# `figcp` Design-System-First & Bidirectional Playbook

`figcp` provides a bidirectional local bridge between AI coding agents and Figma Desktop on the Free/Starter plan with zero REST quotas.

---

## 1. Pipeline 1: AI → Figma (Authoring & Self-Healing)

Follow this 4-step closed loop whenever generating or modifying components in Figma:

### Step 1 — Check Connection & Discover Design System
1. Call `figma_status` to ensure Figma Desktop is connected and check for any manual user canvas edits (`manualChanges`).
2. Call `inspect_design_system` (pass `fontQuery: "IRANSans"` for Persian projects) to inspect:
   - Local Variable Collections (tokens, aliases, resolved hex values)
   - Local Paint, Text, and Effect Styles
   - Component Sets & Standalone Components
   - Installed local font styles

### Step 2 — Build Atomically with `run_figma_js`
Execute creation in a single `run_figma_js` call:
- **Strict Font Preflight**: Always call `await helpers.requireFont({ family: "...", style: "..." })` before editing text to fail fast if font weights are missing.
- **Safe Layout**: Call `helpers.setAutoLayout(frame, { direction, spacing, padding, primaryAlign, counterAlign })` and `helpers.resizeFrameSafe(frame, w, h, { primary, counter })`.
- **Token Binding**: Bind colors and spacing with `helpers.makeBoundPaint(colorVar)` and `helpers.bindVariable(node, field, variable)`.
- **Starter Plan Limits**: Never call `collection.addMode(...)` or assume Team Libraries.

### Step 3 — Verify Geometry & RTL Visually
Call `inspect_node_bounds` with `includeScreenshot: true`:
- Review `lintIssues`:
  - Resolve `child-overflow` errors (absolute positioning overhang is informational).
  - Resolve `sibling-overlap` and `unbound-fill` / `unbound-spacing` warnings.
  - Check `rtl-alignment-mismatch` and `rtl-font-mismatch` (Persian text on default Latin fonts like Inter).
- Inspect the inline PNG screenshot to visually verify bidi numbers and shortcuts (`Ctrl + K`).

### Step 4 — Self-Heal or Revert
- Apply surgical patches via `run_figma_js` and re-verify.
- In case of unexpected broken state, `figma_undo` (`action: "undo"`) undoes the latest Figma document step. It can include intervening user edits, so check recent canvas activity first. `run_figma_js` checkpoints detected mutations by default; read-only scripts do not add a checkpoint.

---

## 2. Pipeline 2: Figma → Code (Context Extraction, Code Connect & Assets)

Follow this workflow when converting a Figma design into frontend code (React, Vue, Tailwind, HTML/CSS):

### Step 1 — Extract Rich Design Context
Call `get_design_context` for the target `nodeId`:
- Returns computed layout (display, flex-direction, gap, padding, alignment).
- Returns colors, borders, corner radii, and box-shadows.
- Automatically matches existing codebase components from `figcp.map.json` (Local Code Connect) so you reuse components instead of writing duplicates from scratch.
- Returns `uiLevel` advisory status.

### Step 2 — Export Independent Assets (Zero REST PAT Required)
Call `export_node_assets`:
- Vector icons/illustrations: `format: "SVG"`, optional `outputDir: "src/assets/icons"`.
- Complex graphics/photos: `format: "PNG"`, optional `outputDir: "src/assets/images"`.

### Step 2b — Deterministic HTML/CSS Export
Call `export_to_html` with an optional `nodeId` (defaults to the current selection) for a standalone HTML preview or fragment. It exports Auto Layout sizing, bound variable CSS custom properties, inline SVG icons, and Persian RTL direction. Large results (over 64 KB) and explicit `outputPath` requests are written to disk to keep MCP responses compact.

### Step 3 — Export DTCG Design Tokens (Optional)
Call `inspect_design_system` with `format: "dtcg"`:
- Returns standard W3C Design Tokens JSON.
- Feed into **Terrazzo** or Tailwind v4 for automated `@theme` token generation.

### Step 4 — Verify Implementation with `ui-level` (Optional)
If visual or DOM verification is needed:
1. Pass `exportUiLevelDir: ".ui-level/snapshots"` to `get_design_context`.
2. If `uiLevel` is not yet installed or enabled, it is available from npm as [`ui-level`](https://www.npmjs.com/package/ui-level):
   - Enable via CLI: `figcp --enable-ui-level` or `figcp --install-ui-level` (or run `npm install -g ui-level` / `npx -y ui-level mcp`).
3. Run `npx ui-level check --spec <path>/spec.json` or compare rendered frontend output against the exported reference screenshot.
