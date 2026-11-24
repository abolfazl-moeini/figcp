---
name: figcp-design-system
description: Closed-loop Design-System-First workflow for building accurate, RTL-safe Figma components and screens via figcp MCP on Figma Starter/Desktop.
---

# `figcp` Design-System-First Playbook (Pipeline 1)

Follow this strict 4-step closed loop whenever designing or editing in Figma using the `figcp` MCP server:

## Step 1 — Discover First (Never Guess Tokens or IDs)
Before writing any creation script, call `inspect_design_system` (pass `fontQuery: "IRANSans"` when working with Persian UI) to retrieve:
- Exact Local Variable Collection names and Variable names/IDs
- Exact Local Text, Paint, and Effect Style IDs
- Existing Component Set IDs (such as Icon sets, Caret, Buttons, Inputs)
- Exact available local font family and style names

## Step 2 — Build Atomically with `run_figma_js`
Execute component/layout creation in a single clean `run_figma_js` script:
- Always bind fills, strokes, padding, gaps, radii, and sizes to Local Variables using `helpers.makeBoundPaint(...)` and `node.setBoundVariable(...)`.
- Always load fonts before editing text (`await helpers.setTextSafe(textNode, text, fontName)` or `await figma.loadFontAsync(fontName)`).
- Always call `helpers.resizeFrameSafe(frame, w, h, { primary, counter })` so `resize()` never silently resets Auto Layout sizing modes.
- For multi-state components, use `figma.combineAsVariants(...)`, `componentSet.addComponentProperty(...)`, and `comp.setReactionsAsync(...)`.
- Pass `commitUndo: false` when running purely read-only `run_figma_js` inspection scripts so undo history stays clean.
- Avoid unbounded synchronous loops (`while (true)`), which cannot be preempted inside Figma's single-threaded QuickJS worker.
- For **Figma Starter** files: never call `collection.addMode(...)` (multi-mode variables are locked on Starter) and never assume Team Library imports are available.

## Step 3 — Deterministic + Visual Verification
Immediately after `run_figma_js` succeeds, call `inspect_node_bounds` on the created `nodeId` with `includeScreenshot: true`:
- Review every item in `lintIssues`:
  - Fix all `error` items (`child-overflow`).
  - Fix all `warning` items (`sibling-overlap`, `unbound-fill`, `unbound-stroke`, `rtl-alignment-mismatch`).
- Inspect the returned PNG screenshot visually — especially for Persian/RTL text mixed with English shortcuts (e.g., `Ctrl + K`), numbers, or punctuation, since Figma's Plugin API does not expose a direct `textDirection` setter.

## Step 4 — Self-Heal or Revert
- If lint or visual issues exist, apply a targeted fix in a follow-up `run_figma_js` call and re-verify with `inspect_node_bounds`.
- If a script leaves broken state, call `figma_undo` (`action: "undo"`) to cleanly revert the last checkpointed step.
