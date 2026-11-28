# AGENTS.md — `figcp` (Figma Design-System MCP Bridge)

This file provides the complete architectural context, constraints, and TDD workflow rules for any AI coding agent working on **`figcp`**. Read this file before modifying code or executing any plan in `plans/`.

---

## 1. Project Mission

**`figcp`** is a local-first, zero-quota **Figma Desktop Plugin + MCP Server** monorepo designed for **Pipeline 1 (Design-System-First directly on Figma)**:
- Enable AI coding agents (Cursor, Claude Code, Codex, OpenCode, etc.) to **read, create, inspect, lint, and iteratively fix** production-grade Design System components and screens directly inside Figma Desktop.
- Work 100% on the **Figma Starter (Free) plan** with **zero Figma REST API / PAT dependency** and **full support for local macOS/Windows fonts** (such as Persian fonts like `IRANSansXFaNum`).
- Enforce a **closed-loop self-healing workflow**: every design script returns structured execution logs, stack traces, deterministic geometry/token lint diagnostics, and optional PNG screenshots so the agent can verify and fix layout or RTL issues autonomously.

---

## 2. Monorepo Structure (npm Workspaces)

```text
figcp/
├── AGENTS.md                       # Global agent context & hard rules (this file)
├── package.json                    # npm workspace root & scripts (Node >=22)
├── tsconfig.base.json              # Shared strict TypeScript config
├── scripts/
│   └── run-tests.mjs               # Cross-platform Node test runner
├── plans/                          # Step-by-step TDD implementation plans
│   ├── 00-overview.md
│   ├── 01-monorepo-and-transport.md
│   ├── 02-plugin-executor-and-tools.md
│   └── 03-ds-linter-skills-and-e2e.md
├── packages/
│   ├── shared/                     # Shared wire protocol, Zod schemas, RPC & lint types
│   ├── server/                     # Local MCP stdio server + WebSocket Leader/Follower bridge + CLI
│   ├── plugin/                     # Figma Desktop Plugin (manifest.json, ui.html, code.ts)
│   ├── linter/                     # Deterministic geometry, overflow/overlap, & token-binding linter
│   └── skills/                     # Agent playbooks (SKILL.md) for Design System & RTL workflows
└── tests/
    ├── helpers/                    # Fake Figma Plugin & mock Figma API test harnesses
    └── e2e/                        # Full MCP stdio <-> Leader/Follower <-> Fake Plugin E2E suites
```

---

## 3. Architecture & Data Flow

```text
AI Client (Cursor / Antigravity / Claude Code / Codex CLI / OpenCode)
   │  MCP over stdio (JSON-RPC) — NEVER write logs to stdout! Use stderr only.
   ▼
packages/server (Leader on 127.0.0.1:1994, or Follower proxying via HTTP /rpc)
   │  WebSocket (ws://127.0.0.1:1994/ws) + loopback shared secret (~/.figcp/token)
   ▼
packages/plugin/ui.html (Hidden/compact iframe — has WebSocket, no figma.* API)
   │  window.postMessage / figma.ui.postMessage
   ▼
packages/plugin/code.ts (Figma QuickJS Worker — has figma.* API, no network)
   │  Serial Queue + eval("(async () => { ... })()") + helpers + commitUndo()
   ▼
Open Figma Desktop Document (multi-file routing via fileKey)
```

### Upstream Foundations & Cherry-Picked Patterns
- **Transport & Multi-File Core**: Adapted from [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge) (`server/src/{bridge,leader,follower,election,node}.ts`) — provides multi-file `fileKey` WebSocket registry and Leader/Follower election so multiple AI clients share one Figma connection.
- **Undo, Helpers & Loopback Auth**: Inspired by [LucasGorgal/localfig](https://github.com/LucasGorgal/localfig) — `figma.commitUndo()` per mutating step, safe `helpers` (font loading, resize-before-sizing), and `~/.figcp/token` loopback auth.
- **Console Capture & Safe Eval**: Inspired by [southleft/figma-console-mcp](https://github.com/southleft/figma-console-mcp) — QuickJS-safe `eval` wrapper, `console.log/warn/error` capture, and `error.stack` reporting.
- **Deterministic Layout Map**: Inspired by [Zfinix/figma-bridge](https://github.com/Zfinix/figma-bridge) — bounding-box overlap, overflow, and alignment diagnostics.

---

## 4. MCP Tool Surface (9 Focused Tools)

To avoid bloating the AI client's context window while covering the full design-system lifecycle, `packages/server` exposes **9 focused MCP tools**:

1. **`figma_status`**: Reports bridge role, port, connected Figma files, and recent manual canvas edits (`manualChanges`).
2. **`run_figma_js`**: Executes arbitrary Figma Plugin API JS inside the target file (`fileKey` optional when 1 file is connected). Runs inside a **serial queue** with configurable timeout (default 30s, max 180s), injects `figma` and `helpers`, captures `console.log/warn/error`, calls `figma.commitUndo()` on mutation, and returns `{ ok, result, logs, error, durationMs }`.
3. **`inspect_design_system`**: Returns a compact, structured snapshot of the target file's Local Variable Collections (with resolved hex & alias chains), Local Paint/Text/Effect Styles, Component Sets & standalone Components, and available fonts (filterable by `fontQuery`, e.g., `IRANSans`), or exports W3C DTCG tokens (`format: "dtcg"`).
4. **`inspect_node_bounds`**: Inspects a node subtree (depth-limited) returning `id`, `name`, `type`, `absoluteBoundingBox`, `absoluteRenderBounds`, Auto Layout settings, bound variable names, **deterministic lint findings** (overflow, sibling overlap, unbound raw colors/spacing, RTL alignment/font checks), and optional inline PNG screenshot (`exportAsync`) returned as native MCP `ImageContent`.
5. **`figma_undo`**: Reverts the last checkpointed `run_figma_js` mutation (via `figma.triggerUndo()`), or saves a named version snapshot (`figma.saveVersionHistoryAsync`) before risky refactors.
6. **`get_design_context`**: Extracts code-generation design context (Auto Layout flexbox/grid, fills/strokes + bound variable names, effects, typography, async `getMainComponentAsync` metadata), matches `figcp.map.json` Local Code Connect mappings (supports `workspaceDir`), and atomically writes `spec.json` + `reference.png` (`exportUiLevelDir`) compatible with `ui-level`.
7. **`export_node_assets`**: Exports a node as clean `SVG` or `PNG` via `exportAsync` (returned inline or written to `outputDir` with path-traversal protection and unique suffix allocation).
8. **`import_web_to_figma`**: **Pipeline 3 (`Live Web → Figma`)**: Captures live web pages or connected user browser tabs via loopback CDP (`Chrome DevTools Protocol`), extracts DOM hierarchy, 1x1 canvas-resolved color tokens (`oklch`, `color-mix`, etc.), CSS variables (`:root --*`), Auto Layout flex/grid heuristics (`per_row`, `maxWidth`), font metadata (with bundler hash-prefix stripping), and interactive component states (`details`, `tabs`, `menus`), builds native Figma frame/text/SVG/image trees and Variable collections, and runs automatic post-import lint verification. Also exposed via CLI: `figcp capture-web <url> [--cdp <port>] [--states]`.
9. **`export_to_html`**: Exports a selected Figma subtree as deterministic HTML/CSS, with CSS variables, optional inline assets, and disk spill for large responses.

---

## 5. Hard Technical Constraints & Figma Gotchas

Every agent writing code in `figcp` MUST respect these verified platform rules:

1. **QuickJS Sandbox `eval` Rule**: Figma's plugin worker restricts `AsyncFunction` constructors; wrap dynamic code with `(0, eval)("(async function(figma, helpers, console, signal) {\\n" + code + "\\n})")` ([reference](https://github.com/prism-ds/prism3/issues/2530)).
2. **Dynamic-Page Async Rules (`"documentAccess": "dynamic-page"`)**:
   - Always use `await inst.getMainComponentAsync()` instead of sync `inst.mainComponent` (write-only under `dynamic-page`).
   - Always pass a `Variable` object (not a string ID) to `node.setBoundVariable(field, variable)`.
   - Never call `figma.on("documentchange", ...)` synchronously at startup without `await figma.loadAllPagesAsync()`; prefer `figma.currentPage.on("nodechange", ...)`.
3. **Serial Execution Queue**: The plugin worker is single-threaded. Never run two `run_figma_js` calls concurrently, or temporary `console.*` interception will collide across calls. Always restore original `console.*` in a `finally` block.
3. **Figma Starter Plan Limits**: Local plugins bypass REST API quotas and Enterprise-only Variables REST endpoints, but **cannot** bypass Starter plan product limits:
   - Supported: Single-mode Local Variables, `setBoundVariable` / `setBoundVariableForPaint`, Local Styles, Component Sets / Variants (`combineAsVariants`), Component Properties (`addComponentProperty`), basic Prototype Reactions (`setReactionsAsync`), and local fonts (`loadFontAsync`).
   - Not supported on Starter: Multi-mode Variables (e.g., adding a 2nd Light/Dark mode), Team Libraries, and conditional/variable Prototype expressions. Never write tests or helpers that assume multi-mode creation succeeds on Starter without graceful fallback.
4. **Font Loading & `resize()` Gotchas**:
   - Always `await figma.loadFontAsync(fontName)` before mutating `textNode.characters` or typography properties.
   - Calling `node.resize(w, h)` resets `textAutoResize` to `NONE` on `TextNode` and resets Auto Layout sizing modes to `FIXED` on frames. Always call `resize()` **before** setting `textAutoResize` or `primaryAxisSizingMode`/`counterAxisSizingMode`.
5. **Persian / RTL Reality**:
   - Local Persian fonts (e.g., `IRANSansXFaNum`) work natively in Figma Desktop once installed on the OS.
   - Figma's public Plugin API does **not** expose a direct `textDirection` property; `textAlignHorizontal = "RIGHT"` alone does not guarantee bidirectional text order. Always verify RTL/bilingual frames using `inspect_node_bounds` with `includeScreenshot: true`.
6. **MCP Stdio Hygiene**: `packages/server` speaks JSON-RPC over `stdout`. **Never** call `console.log()` in `packages/server` — log diagnostics strictly to `stderr` (`console.error`).
7. **Loopback Security**: Bind the bridge strictly to `127.0.0.1`, require the `~/.figcp/token` header/query secret on `/ws` and `/rpc`, and restrict `manifest.json` `networkAccess.devAllowedDomains` to loopback `127.0.0.1` / `localhost` on port `1994`.

---

## 6. Strict TDD & Engineering Rules

1. **Red → Green → Refactor**: For every task in `plans/*.md`, write failing unit/integration tests **first**, confirm they fail (`npm test`), implement the minimal clean code to pass them, then refactor.
2. **No Untested Code**: Every server route, election transition, RPC codec, plugin executor edge case, and linter rule must be covered by automated tests using `tests/helpers/fake-plugin.ts` (so the entire test suite runs in CI/terminal without Figma Desktop open).
3. **Strict TypeScript**: Enable `strict: true`, `noUncheckedIndexedAccess: true`, and validate all external/wire payloads with Zod schemas from `packages/shared`.
4. **Small Atomic Commits**: Complete one numbered task from the active `plans/*.md` file at a time, run `npm run typecheck && npm test && npm run build`, and verify all tests pass before moving to the next task.
5. **Runtime**: Use **Node.js `>=22`** (`npm install`, `npm test`, `npm run build` with `esbuild` + native Node TypeScript stripping) for portable execution and zero-bloat bundling.
