# Phase 4 Plan: Code Review Remediation, Effortless AI→Figma DX & Bidirectional Figma→Code (`ui-level` Bridge)

This document captures a full code review of `figcp` (commit `67126aa`), evaluates bidirectional Figma→Code support and `/Users/moeini/Dev/ui-level` integration, and provides a prioritized TDD implementation plan.

---

## 1. Strategic Evaluations

### Goal 1 — Effortless AI → Figma Connection & Design Authoring
`figcp` already has a solid core (40/40 automated tests passing, Leader/Follower WebSocket bridge, loopback token auth, serial executor, and DS/RTL linter), but **two critical QuickJS proxy bugs** (`R1`, `R2`), a **169 KB Zod bundle leak** (`R3`), and **onboarding/observability gaps** (`R4`, `R5`, `R6`) still prevent frictionless first-try live Figma Desktop usage.

### Goal 2 — Reverse Direction (Figma → Code): **Aligned — Include**
Supporting **Figma → Code** is 100% aligned with `figcp`'s architecture and mission:
- `figcp` already owns the hardest infrastructure: zero-quota local Figma Desktop connectivity, Starter-plan variable/style access without REST API rate limits or paid Dev Mode seats, `dynamic-page` loading, and PNG export.
- Adding a token-aware **design-to-code context extractor** (`get_design_context`) and **asset exporter** (`export_node_assets`) upgrades `figcp` from a one-way authoring script runner into a **complete bidirectional Figma MCP bridge**, while keeping the tool surface compact (6 focused tools total).

### `/Users/moeini/Dev/ui-level` Integration Assessment: **Opt-In Loose Contract (Off by Default, Consent-Gated Setup)**
| Dimension | Decision | Rationale |
| :--- | :--- | :--- |
| **Add `ui-level` as an npm dependency of `figcp`?** | **No** | `ui-level` pulls in `playwright-core`, Chromium, native `sharp`, `odiff-bin`, `colorjs.io`, and Zod v4 (conflicting with `figcp`'s Zod v3). `figcp` must remain a lightweight, zero-browser bridge. |
| **Default state** | **OFF (`disabled`)** | Zero extra packages installed and zero Chromium download by default. Goal 1 (AI → Figma) never needs `ui-level` because Figma Desktop is the renderer and `@figcp/linter` + PNG screenshots close the loop. |
| **Helpful for Goal 2 (Figma → Code)?** | **Yes — Opt-In High Impact** | `ui-level` (`src/adapters/figma.adapter.ts:180`) natively accepts offline `NormalizedSpec` JSON + reference PNG via `level_check` and `level_import_snapshot`. When enabled, `figcp` emits `ui-level`'s `NormalizedSpec` schema directly (zero runtime dependency), giving AI agents **zero-PAT, local-font Figma→Code verification** with Gate 1 (DOM geometry + computed CSS + CIEDE2000 ΔE + CDP CSS rule source) and Gate 2 (SIMD pixel diff + hotspot regions + `triplet.png`). |
| **Consent-gated auto-install UX** | **Ask first, install only after confirmation** | Neither the CLI nor the MCP server ever installs `ui-level` silently. When helpful (during interactive `--setup` or when an AI agent runs Figma→Code via `get_design_context`) and `ui-level` is missing, prompt the user once. Only after explicit user confirmation does `figcp` install `ui-level`, run Chromium setup if needed, register the `ui-level` MCP entry, and persist `uiLevel: "enabled"` in `~/.figcp/config.json` (or persist `"declined"` so the user is not nagged again). |

---

## 2. Code Review Findings

### Critical (Live Figma Blockers)

#### R1 — `createGuardedFigmaProxy` passes `Proxy` objects into native Figma QuickJS methods
- **Location:** `packages/plugin/src/executor.ts:98-156`
- **Issue:** Calling `const f = figma.createFrame(); const t = figma.createText(); f.appendChild(t);` passes a JS `Proxy` (`t`) into Figma's native C++/QuickJS `appendChild` binding (and similarly for `combineAsVariants`, `setBoundVariableForPaint`, `currentPage.selection`, `viewport.scrollAndZoomIntoView`). Native QuickJS host bindings inspect internal opaque pointers (`JS_GetOpaque`), which fails on `Proxy` wrappers with `TypeError`.
- **Fix:** Maintain a `proxyToTarget = new WeakMap<object, unknown>()` inside `createGuardedFigmaProxy` and recursively unwrap arguments (including arrays and plain option objects) before invoking native methods or `Reflect.set`.

#### R2 — `helpers` bypasses the guarded `figma` proxy (abort & mutation tracking)
- **Location:** `packages/plugin/src/code.ts:15`, `packages/plugin/src/code.ts:103`
- **Issue:** `const helpers = createPluginHelpers(figma)` is instantiated once against the raw `figma` global. Calls inside `run_figma_js` via `helpers.setTextSafe(...)`, `helpers.makeBoundPaint(...)`, `helpers.resizeFrameSafe(...)`, or `helpers.reveal(...)` bypass `state.aborted` (post-timeout mutation guard) and `state.mutated` (mutate-then-throw `commitUndo()` tracking).
- **Fix:** Pass a `helpersFactory: (guardedFigma) => createPluginHelpers(guardedFigma)` into `SerialPluginExecutor.execute` so `helpers` always binds to that execution's `guardedFigma` proxy.

### High (Bundle Size, Connection UX & Setup Ergonomics)

#### R3 — `packages/plugin/dist/code.js` bundles all of `zod` (~169 KB)
- **Location:** `packages/plugin/src/inspectors.ts:1`, `packages/shared/src/index.ts:1`, `packages/shared/package.json`
- **Issue:** `inspectors.ts` imports `normalizeNodeId` from `@figcp/shared`. Because `@figcp/shared` re-exports top-level `z.object(...)` definitions from `protocol.ts` without `"sideEffects": false`, `esbuild` cannot tree-shake `zod`, bloating the QuickJS plugin bundle to `168,908` bytes.
- **Fix:** Extract pure zero-dependency utilities (`normalizeNodeId`) into `packages/shared/src/utils.ts` exposed via `@figcp/shared/utils` (or mark pure exports cleanly) so `packages/plugin` imports zero `zod` runtime code, shrinking `dist/code.js` to ~15–20 KB.

#### R4 — No connection discovery tool / MCP error wrapping
- **Location:** `packages/server/src/mcp.ts:17-209`
- **Issue:**
  1. AI agents have no way to list connected Figma files (`fileKey`, `fileName`, `pageName`) or check bridge health before calling tools; multi-file targeting requires triggering a disambiguation error first.
  2. Transport exceptions (`transport.sendCommand` throwing on disconnect, timeout, or disambiguation) are not caught inside tool handlers to return structured, actionable MCP `{ isError: true }` hints.
- **Fix:** Add a `figma_status` (or `list_figma_files`) tool / resource plus a shared `handleToolCall` wrapper in `mcp.ts` that formats transport errors cleanly with next-step instructions (`run figcp --setup`, `open Plugins -> Development -> figcp`, or specify `fileKey`).

#### R5 — `--setup` misses clients, unconditionally creates `~/.claude.json`, lacks `--doctor`, and does not install `SKILL.md`
- **Location:** `packages/server/src/cli/setup.ts:65-228`, `packages/server/src/index.ts:9-50`
- **Issue:**
  1. `dirname("~/.claude.json")` is `$HOME`, which always exists, so `--setup` creates `~/.claude.json` even on machines without Claude Code.
  2. Missing client targets: **Antigravity** (`~/.gemini/antigravity/mcp_config.json`) and **Codex CLI** (`~/.codex/config.toml`).
  3. `manifestRaw.replaceAll("1994", String(port))` (`setup.ts:158`) does blind string replacement instead of JSON-aware `devAllowedDomains` rewriting.
  4. No `--doctor` diagnostic command (checking Node version, built artifacts, `~/.figcp/token`, `~/.figcp/plugin/`, port `1994` health, and connected Figma files) and no `--install-skill` option for `packages/skills/figcp/SKILL.md`.
- **Fix:** Parse & rewrite `manifest.json` as JSON, gate Claude Code on `existsSync("~/.claude.json") || existsSync("~/.claude")`, add Antigravity/Codex support, add `figcp --doctor` and npm scripts (`npm run setup`, `npm run doctor`).

### Medium (Design Authoring, Bidirectional Extraction, Transport & Linter)

#### R6 — Thin Goal-1 authoring helpers & `resizeFrameSafe` trap
- **Location:** `packages/plugin/src/helpers.ts:84-130`
- **Issue:** `resizeFrameSafe` throws if called on a frame with `layoutMode === "NONE"`. Agents also repeatedly hand-write boilerplate for Auto Layout setup, binding scalar variables, finding styles/components, and creating Starter-safe variables.
- **Fix:** Guard `layoutMode !== "NONE"` in `resizeFrameSafe` and add ergonomic helpers (`setAutoLayout`, `bindVariable`, `findStyle`, `findComponent`, `getOrCreateVariable`, `setTextStyleSafe`).

#### R7 — `inspect_design_system` omits standalone `COMPONENT`s and resolved style/variable values
- **Location:** `packages/plugin/src/inspectors.ts:40-168`
- **Issue:**
  1. Scans only `COMPONENT_SET`, missing standalone `COMPONENT` icons/elements.
  2. Paint and Effect styles return only `{ id, name }` without color hex or shadow/blur specs.
  3. Color variables return raw float objects `{ r, g, b, a }` instead of hex/rgba, and aliases return only name chains without the final resolved value.
- **Fix:** Include standalone `components` (not parented by `COMPONENT_SET`), serialize Paint/Effect/Text style details, and include resolved hex/value alongside alias chains.

#### R8 — Missing Figma → Code context extractor & asset exporter (Goal 2 + `ui-level`)
- **Location:** `packages/plugin/src/inspectors.ts`, `packages/server/src/mcp.ts`, `packages/shared/src/protocol.ts`
- **Issue:** `inspect_node_bounds` only returns minimal lint fields—no CSS-ready colors, gradients, borders, corner radii, shadows, typography (`fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`), Auto Layout alignment/sizing, `INSTANCE` component metadata, or SVG/PNG asset export.
- **Fix:** Add `get_design_context` (with optional `exportUiLevelDir` / `NormalizedSpec` output) and `export_node_assets` (`SVG` / `PNG`).

#### R9 — Transport heartbeat & failover latency
- **Location:** `packages/server/src/transport/bridge.ts:36-64`, `packages/plugin/src/ui.template.html:86-102`
- **Issue:**
  1. 15s heartbeat with a 1-miss cutoff (30s) can drop healthy backgrounded Figma Desktop tabs where Chromium throttles timers; incoming RPC messages do not refresh `isAlive`.
  2. Initial reconnect backoff in `ui.template.html` starts at `1000ms` (up to `5000ms`), which can exceed `takeoverReconnectWaitMs` (`1500ms`) during Leader→Follower failover.
- **Fix:** Refresh `isAlive = true` on any WS message, increase heartbeat tolerance (30s interval, 2 missed pongs), and start `ui.template.html` reconnect backoff at `300ms` (`300 → 800 → 2000 → 5000`).

#### R10 — Linter false positives & missing RTL/scale guards
- **Location:** `packages/linter/src/rules.ts:34-160`
- **Issue:**
  1. `child-overflow` flags intentional `layoutPositioning === "ABSOLUTE"` badges/overlays as `"error"` instead of `"warning"`/`"info"`.
  2. `sibling-overlap` is `O(n²)` without a child-count guard for large frames.
  3. Missing RTL font check: Persian/Arabic `TEXT` nodes left on default `"Inter"` or `"Roboto"` fail silently in Figma without warning.
- **Fix:** Downgrade `ABSOLUTE` child overhang to `"info"`, cap or sweep-line `sibling-overlap` for large containers, and add `rtl-font-mismatch` when Persian/Arabic text uses known Latin-only defaults (`Inter`, `Roboto`, `SF Pro`).

---

## 3. Phased TDD Implementation Plan

### Phase 4A — Critical Live-Figma Fixes & Bundle Hygiene (Do First)
1. **Task 4A.1 — Unwrap Proxies in `createGuardedFigmaProxy` (R1)**
   - **Red:** Add tests in `packages/plugin/src/__tests__/executor.test.ts` where mock `figma.createFrame()` returns objects checked by strict identity (`===`) inside `appendChild`, `combineAsVariants`, `setBoundVariableForPaint`, and `currentPage.selection` (asserting native methods receive raw targets, never Proxy instances).
   - **Green:** Add `proxyToTarget` WeakMap and `unwrapValue()` in `packages/plugin/src/executor.ts` for method args and property setters.
2. **Task 4A.2 — Bind `helpers` to `guardedFigma` per execution (R2)**
   - **Red:** Add test verifying timed-out script calling `helpers.setTextSafe(...)` / `helpers.reveal(...)` is aborted, and script mutating via `helpers` then throwing triggers `commitUndo()`.
   - **Green:** Update `SerialPluginExecutor.execute` to accept `helpersApi` or `(guardedFigma) => helpers`, and update `packages/plugin/src/code.ts`.
3. **Task 4A.3 — Zero-Zod Plugin Bundle (R3)**
   - **Red:** Add artifact test in `tests/e2e/closed-loop.test.ts` asserting `packages/plugin/dist/code.js` does not contain `"ZodError"` and is `< 40 KB`.
   - **Green:** Split `packages/shared/src/utils.ts` (`normalizeNodeId`, color/format helpers), export `@figcp/shared/utils` in `packages/shared/package.json`, and import from `@figcp/shared/utils` in `packages/plugin`.

### Phase 4B — Goal 1: Effortless Connection, Diagnostics, Change Tracking & Authoring Ergonomics
4. **Task 4B.1 — `figma_status` Tool, Manual Change Tracking (`figma_changes`) & Structured MCP Errors (R4)**
   - **Red:** Test `figma_status` (0, 1, 2 files connected), test `documentchange` tracking in plugin worker recording ONLY human edits made between AI commands (ignoring mutations made during `run_figma_js`) and surfacing them in `figma_status` / `run_figma_js` responses, and verify disconnected tool calls return structured `{ isError: true }` guidance.
   - **Green:**
     - Add bounded ring-buffer `documentchange` tracker in `packages/plugin/src/code.ts` (gated by `isAgentCommandRunning`) reporting `{ nodeId, nodeName, changeType, timestamp }` + `sinceSeq` cursor (inspired by `localfig`).
     - Add `figma_status` tool in `packages/server/src/mcp.ts` (returns bridge role, port, connected files, and pending manual user changes) and wrap all tool handlers with clean error guidance.
5. **Task 4B.2 — Large Payload Spill-to-Disk (`> 64 KB`) Guard**
   - **Red:** Test `inspect_design_system`, `inspect_node_bounds`, and `get_design_context` returning JSON payloads `> 64 KB`: assert full JSON is written to `~/.figcp/cache/<tool>-<ts>.json` and MCP text block returns a compact summary + `fullOutputPath` while preserving inline PNG `ImageContent` (inspired by `javidselimov/figma-bridge`).
   - **Green:** Add `spillLargePayload(toolName, payload, cacheDir, thresholdBytes = 65_536)` helper in `packages/server/src/mcp.ts` with automatic old-cache pruning.
6. **Task 4B.3 — Harden `--setup`, Add `--doctor` & Client Coverage (R5)**
   - **Red:** Test JSON-based port rewriting in `manifest.json`, Claude Code detection (no accidental `~/.claude.json` creation when absent), Antigravity MCP config merge, `--install-skill`, and `--doctor` JSON report.
   - **Green:** Update `packages/server/src/cli/setup.ts`, create `packages/server/src/cli/doctor.ts`, wire `--doctor` & `--install-skill` in `packages/server/src/index.ts`, and add `npm run setup` / `npm run doctor` in root `package.json`.
7. **Task 4B.4 — Richer Authoring Helpers, Strict Font Preflight & RTL Reference Fixture (R6, R7)**
   - **Red:** Test `resizeFrameSafe` on `layoutMode: "NONE"`, `setAutoLayout`, `bindVariable`, `findStyle`, `findComponent`, strict `requireFont(fontName)` preflight (throwing explicit error with exact installed weights if e.g. `IRANSansXFaNum` weight is missing rather than silent fallback), standalone components in `inspect_design_system`, and hex + resolved alias values.
   - **Green:** Implement in `packages/plugin/src/helpers.ts` and `packages/plugin/src/inspectors.ts`, update `DesignSystemSnapshotSchema`, and add a reusable RTL visual verification script (`scripts/rtl-reference-fixture.js`) covering pure Persian text, bilingual text (`Ctrl + K`, digits, URL), RTL icon+label row, and narrow-width truncation.
8. **Task 4B.5 — Transport Failover & Linter Refinements (R9, R10)**
   - **Red:** Test heartbeat `isAlive` refresh on message, fast reconnect backoff (`300ms`), `ABSOLUTE` overflow severity downgrade, `sibling-overlap` guard, and `rtl-font-mismatch`.
   - **Green:** Update `packages/server/src/transport/bridge.ts`, `packages/plugin/src/ui.template.html`, and `packages/linter/src/rules.ts`.

### Phase 4C — Goal 2: Bidirectional Figma → Code, Local Code Connect, DTCG Tokens & Opt-In `ui-level` Bridge
9. **Task 4C.1 — `get_design_context`, Local Code Connect (`figcp.map.json`) & `ui-level` `NormalizedSpec` Exporter (R8)**
   - **Red:**
     - Unit-test Figma node extraction (fills/hex, strokes, corner radii, shadows/effects, Auto Layout alignment/sizing, typography with `lineHeight`/`letterSpacing`/`fontWeight`, `INSTANCE` `mainComponent` + properties, bound variable token names).
     - Test loading optional `figcp.map.json` from workspace root (`{ "Button/Primary": { "file": "src/components/Button.tsx", "export": "Button" } }`) so matching `INSTANCE` nodes automatically attach `codeConnect` hints and prevent duplicate component generation.
     - Verify `exportUiLevelDir` defaults to off (`undefined`) and validate exported JSON when enabled against `ui-level`'s `NormalizedSpec` shape (`adapter: "figma"`, relative `rect`, CSS-longhand `styles`, `figmaId`, `selector: '[data-figma-id="..."]'`, `text`).
   - **Green:**
     - Add `handleGetDesignContext` in `packages/plugin/src/inspectors.ts`.
     - Add `packages/server/src/code-connect.ts` to resolve `figcp.map.json` mappings cleanly.
     - Add pure `toUiLevelNormalizedSpec(...)` converter in `packages/shared/src/ui-level-export.ts` (zero dependency on `ui-level`).
     - Expose `get_design_context` in `packages/server/src/mcp.ts` with optional `exportUiLevelDir` (writes `<exportUiLevelDir>/spec.json` + `<exportUiLevelDir>/reference.png` ready for `ui-level`).
10. **Task 4C.2 — Independent Asset (`SVG`/`PNG`) & W3C DTCG Token Export (R8)**
    - **Red:**
      - Test exporting vector/icon nodes as clean `SVG` string and raster/complex nodes as `PNG` (inline or saved under workspace `outputDir` with path-traversal protection) via `exportAsync` with zero REST API dependency.
      - Test exporting Local Variables to standard **W3C DTCG JSON** (`$type`, `$value`, `{alias.path}` references) compatible with **Terrazzo** (CSS / Tailwind v4).
    - **Green:**
      - Add pure `toDtcgTokens(...)` formatter in `packages/shared/src/dtcg-export.ts`.
      - Implement `handleExportNodeAssets` in `packages/plugin/src/inspectors.ts` and register `export_node_assets` (plus `format: "dtcg"` option on `inspect_design_system` or `export_tokens`) in `packages/server/src/mcp.ts`.
11. **Task 4C.3 — Consent-Gated `ui-level` Detection & Optional Installer (`--with-ui-level`)**
    - **Red:** Test `~/.figcp/config.json` state (`{ uiLevel: "disabled" | "enabled" | "declined" }`), fast zero-dep availability detection (`detectUiLevel()`), non-interactive `--setup` leaving `ui-level` untouched by default, `--setup --with-ui-level` (and interactive confirmed prompt) installing/registering `ui-level` MCP config cleanly, and `get_design_context` returning `uiLevel` advisory metadata without ever installing silently.
    - **Green:**
      - Add `packages/server/src/cli/ui-level-addon.ts`: detects whether `ui-level` is installed, reads/writes `~/.figcp/config.json`, and implements consent-gated setup (`installAndEnableUiLevel`) only after explicit confirmation or `--with-ui-level` / `--enable-ui-level`.
      - Wire optional interactive TTY prompt in `--setup` (default `No`; skipped in non-TTY / `--no-prompt`) and advisory `uiLevel` status in `get_design_context`.
12. **Task 4C.4 — Update `README.md`, `SKILL.md` & Cross-Contract E2E Verification**
    - Update `README.md` with:
      - `figcp.map.json` quick example (Local Code Connect).
      - **Optional Add-ons** section (all off by default, zero core dependencies):
        - **`ui-level`** (Playwright/CDP DOM+CSS + CIEDE2000 ΔE + ODiff visual verification for Figma → Code; install/enable via `figcp --enable-ui-level`).
        - **Terrazzo** (convert `figcp` DTCG JSON → CSS / Tailwind v4) & **Tokens Studio** (only if multi-theme Light/Dark Git sync is needed on Starter).
        - **SVGO** (optional cleanup of exported SVGs) & **MCP Inspector** (server debugging).
    - Update `packages/skills/figcp/SKILL.md` with **Pipeline 2 (Figma → Code)**: check `codeConnect` hits from `figcp.map.json`, check `uiLevel` status (ask user before installing if missing), use `requireFont` preflight for Persian text, and verify manual `figma_changes` before patching.
    - Add cross-contract test verifying `figcp`'s exported `NormalizedSpec` JSON and DTCG JSON structures without adding external runtime dependencies.

### Phase 4D — Live Figma Desktop Acceptance Gate
After `npm run typecheck && npm run build && npm test` pass with 0 failures:
1. Run `npm run setup && npm run doctor`.
2. Import `~/.figcp/plugin/manifest.json` in Figma Desktop and verify:
   - `figma_status` reports the active file and detects manual canvas edits (`figma_changes`).
   - `inspect_design_system` lists variables (hex + resolved aliases + optional DTCG export), styles, component sets, standalone components, and local Persian fonts (`IRANSansXFaNum`).
   - `run_figma_js` executes `appendChild`, `combineAsVariants`, `setBoundVariableForPaint`, `requireFont`, and `helpers.*` with zero QuickJS proxy errors; run `scripts/rtl-reference-fixture.js` and visually verify the RTL screenshot.
   - `inspect_node_bounds` returns clean lint results, spills payloads `> 64 KB` cleanly, and returns inline PNG screenshots.
   - `get_design_context` attaches `figcp.map.json` Code Connect mappings, exports `SVG` assets + `spec.json`/`reference.png`, and `ui-level` verifies a rendered HTML implementation cleanly.
