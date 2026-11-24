# Phase 2 Plan: Figma Desktop Plugin Executor & 4-Tool MCP Server (TDD)

**Goal:** Implement the Figma Desktop Plugin (`code.ts`, `ui.html`, `manifest.json`) with a serial QuickJS-safe `eval` executor, console/stack capture, built-in `helpers`, and `commitUndo()`, plus the MCP stdio server exposing exactly **4 tools**: `run_figma_js`, `inspect_design_system`, `inspect_node_bounds`, and `figma_undo`.

**Prerequisite:** Phase 1 exit gate passes (`bun test`).

---

## Task 2.1 — Plugin Serial Executor & Console Capture (`packages/plugin/src/executor.ts`)

### Red (Write Failing Tests First)
Create `packages/plugin/src/__tests__/executor.test.ts` (using a lightweight mock `figma` object):
1. **Basic async execution**: Running `"return await Promise.resolve(42);"` returns `{ ok: true, result: 42, logs: [] }`.
2. **Console capture & restoration**: Running code with `console.log("a", 1)`, `console.warn("b")`, `console.error("c")` captures all 3 entries in `logs[]` AND restores original `console.log/warn/error` after execution (even when code throws).
3. **Error & stack capture**: Running `"throw new Error('boom');"` returns `{ ok: false, error: { name: 'Error', message: 'boom', stack: expect.any(String) }, logs }`.
4. **Serial queue guarantee**: Dispatching 2 async scripts concurrently (`script1` takes 50ms and logs `"first"`, `script2` logs `"second"`) guarantees `script1` completes before `script2` starts, with zero log cross-contamination.
5. **Safe JSON serialization**: Returning a raw mock Figma node (with circular `.parent` reference) safely collapses it to `{ id, name, type }` instead of throwing `TypeError: Converting circular structure to JSON`.
6. **Undo checkpointing**: When `commitUndo` option is `true` and execution succeeds without throwing, `figma.commitUndo()` is called once; when execution throws, `figma.commitUndo()` is NOT called.
7. **Timeout guard**: A script returning a never-resolving Promise rejects cleanly after `timeoutMs` and unlocks the queue for subsequent calls.

### Green (Implement)
Create `packages/plugin/src/executor.ts`:
- Use `eval("(async function(figma, helpers) {\n" + code + "\n})")` (compatible with Figma's QuickJS sandbox where `AsyncFunction` is restricted).
- Implement an internal FIFO Promise queue (`SerialQueue`) so scripts never overlap.
- Implement `safeSerialize(value, maxDepth = 6)` to handle Figma SceneNodes and prevent circular JSON crashes.
- Capture `console.log`, `console.warn`, `console.error` inside `try/finally`.

### Verification
- `bun test packages/plugin/src/__tests__/executor.test.ts` passes 100%.

---

## Task 2.2 — Built-in Plugin `helpers` Library (`packages/plugin/src/helpers.ts`)

### Red (Write Failing Tests First)
Create `packages/plugin/src/__tests__/helpers.test.ts` with mock `figma` API:
1. `helpers.hexToRgb("#3B82F6")` → `{ r: 59/255, g: 130/255, b: 246/255 }` and `helpers.hexToRgba("#3B82F680")` → `{ r, g, b, a }`.
2. `helpers.loadFontSafe({ family: "IRANSansXFaNum", style: "Regular" })`: calls `figma.loadFontAsync` and returns `true`; if font is missing, returns a structured error listing matching installed font families from `figma.listAvailableFontsAsync()`.
3. `helpers.setTextSafe(textNode, "سلام", fontName)`: verifies `loadFontAsync` is called **before** assigning `textNode.characters`.
4. `helpers.resizeFrameSafe(frame, 340, 44, { primary: "FIXED", counter: "FIXED" })`: verifies `frame.resize(340, 44)` is called **before** setting `primaryAxisSizingMode` and `counterAxisSizingMode` (preventing Figma's resize-reset gotcha).
5. `helpers.makeBoundPaint(colorVar, fallbackRgb)`: uses `figma.variables.setBoundVariableForPaint` when `colorVar` exists, and falls back to solid paint when `null`.

### Green (Implement)
Create `packages/plugin/src/helpers.ts` implementing all 5 helpers plus `helpers.reveal(nodes)` and `helpers.findVariable(collectionHint, varName)`.

### Verification
- `bun test packages/plugin/src/__tests__/helpers.test.ts` passes 100%.

---

## Task 2.3 — Plugin Inspection Handlers (`inspect_design_system`, `inspect_node_bounds`, `figma_undo`)

### Red (Write Failing Tests First)
Create `packages/plugin/src/__tests__/inspectors.test.ts`:
1. **`handleInspectDesignSystem`**:
   - Reads local variable collections, variables (with resolved alias names), local paint/text/effect styles, and component sets (with variant property definitions).
   - Supports optional `fontQuery` (e.g., `"IRANSans"`) to return matching installed fonts without dumping 2,000+ system fonts.
2. **`handleInspectNodeBounds`**:
   - Accepts `nodeId` (auto-normalizing `"5031-4449"` → `"5031:4449"`) or defaults to current selection.
   - Extracts `id`, `name`, `type`, `absoluteBoundingBox`, `absoluteRenderBounds`, `layoutMode`, `itemSpacing`, padding, `boundVariables`, and children up to `maxDepth` (default `4`).
   - When `includeScreenshot: true`, calls `node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } })` and returns base64 PNG bytes.
3. **`handleFigmaUndo`**:
   - Action `"undo"` calls `figma.triggerUndo()` and returns `{ ok: true, action: "undo" }`.
   - Action `"snapshot"` calls `figma.saveVersionHistoryAsync(title)` and returns `{ ok: true, action: "snapshot", title }`.

### Green (Implement)
Create `packages/plugin/src/inspectors.ts` and `packages/plugin/src/code.ts` (wiring `figma.ui.onmessage` to the executor & inspector handlers).

### Verification
- `bun test packages/plugin` passes 100%.

---

## Task 2.4 — Plugin UI Bridge & Manifest (`packages/plugin/src/ui.html` & `manifest.json`)

### Steps
1. Create `packages/plugin/src/ui.template.html`:
   - Compact status bar UI (`width: 240, height: 64`) showing connection state (`Connected` / `Reconnecting...`), active `fileKey`, last command duration, and a manual `Reconnect` button.
   - Connects to `ws://127.0.0.1:${PORT}/ws?token=${TOKEN}` with exponential backoff auto-reconnect (1s → 2s → 5s max).
   - Relays incoming RPC requests to `parent.postMessage({ pluginMessage: msg }, "*")` and forwards worker replies back over WebSocket.
2. Create `packages/plugin/manifest.json`:
   - `"documentAccess": "dynamic-page"`
   - `"editorType": ["figma"]`
   - `"networkAccess": { "allowedDomains": ["none"], "devAllowedDomains": ["http://localhost:1994", "ws://localhost:1994"] }`
3. Add `packages/plugin/scripts/build.ts` (using `Bun.build`) to compile `code.ts` → `dist/code.js` (ES2017 target for Figma QuickJS compatibility) and copy `manifest.json` + `ui.template.html`.

### Verification
- `bun run build:plugin` produces `packages/plugin/dist/{manifest.json,code.js,ui.template.html}` with zero errors.

---

## Task 2.5 — 4-Tool MCP Stdio Server (`packages/server/src/mcp.ts`)

### Red (Write Failing Tests First)
Create `packages/server/src/__tests__/mcp-tools.test.ts`:
1. Verify `tools/list` returns **exactly 4 tools**: `run_figma_js`, `inspect_design_system`, `inspect_node_bounds`, `figma_undo`.
2. Verify `run_figma_js` forwards `{ code, fileKey, timeoutMs, commitUndo }` through `TransportNode` to `FakeFigmaPlugin` and returns JSON text content with `ok`, `result`, `logs`, and `error`.
3. Verify `inspect_node_bounds` with `includeScreenshot: true` returns **both** a `text` content block (bounds + lint summary) **and** a native MCP `image` content block (`mimeType: "image/png"`), NOT a huge base64 string stuffed inside JSON text.
4. Verify no `console.log` calls exist anywhere in `packages/server/src/` (add a static grep test to prevent stdout corruption!).

### Green (Implement)
Create `packages/server/src/mcp.ts` and `packages/server/src/index.ts`:
- Register the 4 tools using `@modelcontextprotocol/sdk` with strict Zod input schemas.
- Wire `StdioServerTransport` and graceful shutdown (`SIGINT`/`SIGTERM`/`stdin` EOF).

### Phase 2 Exit Gate
```bash
bun run typecheck
bun test
bun run build
```
All unit and Fake-Plugin integration tests pass; plugin bundle compiles cleanly for QuickJS.
