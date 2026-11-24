# Phase 3 Plan: Deterministic DS/RTL Linter, Agent Skill, CLI Setup & Live E2E (TDD)

**Goal:** Turn `figcp` from a raw bridge into a **high-precision closed-loop Design System engine** by adding deterministic geometry/token linting, an Agent Skill (`SKILL.md`), a one-command `--setup` CLI installer, and a live Figma Desktop acceptance suite.

**Prerequisite:** Phase 2 exit gate passes (`bun test && bun run build`).

---

## Task 3.1 — Deterministic Geometry, Token & RTL Linter (`packages/linter`)

Because `packages/linter` operates on plain `NodeBoundsSummary` JSON objects returned by `inspect_node_bounds`, it is 100% pure TypeScript and unit-testable without Figma.

### Red (Write Failing Tests First)
Create `packages/linter/src/__tests__/linter.test.ts` covering every rule:
1. **`child-overflow`**: Child `absoluteBoundingBox` extends beyond parent `absoluteBoundingBox` (tolerance `1px`) when parent does not clip or is an input/card → emits `severity: "error"`.
2. **`sibling-overlap`**: Two non-absolute siblings inside the same Auto Layout or non-overlay container overlap by `> 1px` → emits `severity: "warning"`.
3. **`unbound-fill` / `unbound-stroke`**: Visible solid fill or stroke on a non-vector node has no `boundVariables` and no `fillStyleId`/`strokeStyleId` → emits `severity: "warning"` (catches hardcoded hex colors!).
4. **`unbound-spacing`**: Auto Layout frame has non-zero `itemSpacing` or `padding*` with no bound variable → emits `severity: "info"`.
5. **`rtl-alignment-mismatch`**: A `TEXT` node whose `characters` contains Persian/Arabic Unicode (`[\u0600-\u06FF]`) but has `textAlignHorizontal === "LEFT"` → emits `severity: "warning"` suggesting `"RIGHT"`.
6. **`bilingual-rtl-check`**: A `TEXT` node mixing Persian characters with Latin/shortcut strings (e.g., `"جستجو (Ctrl + K)"`) → emits `severity: "info"` advising visual screenshot check.
7. **Clean component passes**: A properly bound RTL Search Box fixture returns `issues: []`.

### Green (Implement)
Create `packages/linter/src/rules.ts` and `packages/linter/src/index.ts`:
- Export `lintNodeTree(root: NodeBoundsSummary): LintIssue[]`.
- Wire `lintNodeTree` into `packages/server/src/mcp.ts` inside the `inspect_node_bounds` tool handler so every bounds inspection automatically attaches `lintIssues`.

### Verification
- `bun test packages/linter` and `bun test packages/server` pass 100%.

---

## Task 3.2 — Agent Skill for Pipeline 1 (`packages/skills/figcp/SKILL.md`)

Create `packages/skills/figcp/SKILL.md` so any coding agent (Cursor, Claude Code, Codex, OpenCode) automatically follows the exact closed-loop Design System workflow:
1. **Step 1 — Discover First**: Always call `inspect_design_system` before writing any component to fetch exact variable names, text/effect style IDs, icon component IDs, and installed Persian fonts (never guess IDs or hardcode hex values).
2. **Step 2 — Atomic Script Execution**: Build components/variants in a single clean `run_figma_js` script using `helpers` (`loadFontSafe`, `resizeFrameSafe`, `makeBoundPaint`), `combineAsVariants`, `addComponentProperty`, and `setReactionsAsync`.
3. **Step 3 — Deterministic + Visual Verify**: Call `inspect_node_bounds` with `includeScreenshot: true` on the newly created node ID.
4. **Step 4 — Self-Heal Loop**: Fix every `error` and `warning` in `lintIssues` (overflow, overlap, unbound colors, RTL alignment) and visually inspect the PNG for bilingual Persian/English ordering. Use `figma_undo` if a script leaves broken state.
5. **Starter Plan Rules**: Explicitly instruct the agent never to call `addMode()` on Starter files and never to assume Team Library imports are available.

---

## Task 3.3 — One-Command CLI Installer (`figcp --setup`)

### Red (Write Failing Tests First)
Create `packages/server/src/__tests__/setup.test.ts` (using isolated temp home directories):
1. Running `runSetup({ homeDir, dryRun: false })` writes:
   - `<homeDir>/.figcp/token`
   - `<homeDir>/.figcp/plugin/manifest.json`
   - `<homeDir>/.figcp/plugin/code.js`
   - `<homeDir>/.figcp/plugin/ui.html` (with the generated loopback token baked in)
2. Merging MCP config into existing Cursor (`~/.cursor/mcp.json`), Claude Code (`~/.claude.json`), and OpenCode (`~/.config/opencode/opencode.json`) preserves all existing MCP servers and writes a `.figcp.bak` backup first.
3. `--dry-run` makes zero filesystem writes.

### Green (Implement)
Create `packages/server/src/cli/setup.ts` and wire `--setup`, `--dry-run`, `--print-path`, and `--help` flags in `packages/server/src/index.ts`.

### Verification
- `bun test packages/server/src/__tests__/setup.test.ts` passes 100%.

---

## Task 3.4 — Automated Full-Stack E2E Test Suite (`tests/e2e/closed-loop.test.ts`)

### Write & Run E2E Test
Create `tests/e2e/closed-loop.test.ts` spawning the real compiled MCP server over `stdio` + connecting `FakeFigmaPlugin`:
1. Client calls `inspect_design_system` → receives tokens, styles, and `IRANSansXFaNum`.
2. Client calls `run_figma_js` → receives `{ ok: true, result: { id: "100:1" }, logs: [...] }`.
3. Client calls `inspect_node_bounds` (`nodeId: "100-1"`, `includeScreenshot: true`) → verifies dash-to-colon normalization, receives `lintIssues` array, AND receives native MCP `image/png` block.
4. Client calls `figma_undo` → verifies undo command reaches Fake Plugin.

---

## Task 3.5 — Live Figma Desktop Acceptance Checklist (Manual Final Gate on macOS)

After `npm run typecheck && npm test && npm run build` all pass:
1. Run `node packages/server/dist/index.js --setup`.
2. In Figma Desktop (Starter plan): `Plugins → Development → Import plugin from manifest...` → select `~/.figcp/plugin/manifest.json`.
3. Run the `figcp` plugin in a real design file and verify all 8 live checks from your AI client:
   - [ ] `inspect_design_system` returns Local Variables, Styles, and `IRANSansXFaNum`.
   - [ ] `run_figma_js` builds the 16-variant RTL **Search Box** (`Desktop`/`Mobile` × `Empty`/`Filled` × `Default`/`Hover`/`Focus`/`Disabled`) with `Ctrl + K`, Caret, Component Properties, and Prototype Reactions.
   - [ ] `inspect_node_bounds` returns zero `child-overflow` / `sibling-overlap` errors and a crisp PNG screenshot.
   - [ ] `console.log` and intentional `throw new Error()` return structured `logs` and `stack`.
   - [ ] `figma_undo` cleanly reverts the last `run_figma_js` step.
   - [ ] Closing and reopening the plugin auto-reconnects within 5 seconds.
   - [ ] Opening the plugin in a 2nd Figma tab allows targeting each file via `fileKey`.
   - [ ] Opening 2 AI clients simultaneously (e.g., Cursor + Claude Code) shares the bridge cleanly via Leader/Follower.
