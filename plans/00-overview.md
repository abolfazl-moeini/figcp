# `figcp` — Master Implementation Overview & Dependency Strategy

This document defines the overall roadmap, how upstream open-source code/patterns are integrated into the monorepo, and the verification gates between phases.

---

## 1. Dependency Integration Strategy (How to Use Upstream Projects)

Do **NOT** `git clone` external repositories inside `figcp/` as nested git repos or `git submodule`s. Nested repos confuse coding agents, duplicate tooling, and create merge friction when heavily modifying the MCP surface.

Instead, use a **Clean Vendor + Cherry-Pick** strategy:

| Upstream Reference | What to Take | How to Integrate |
| :--- | :--- | :--- |
| [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge) (`v0.0.27`) | Leader/Follower HTTP+WS transport (`bridge.ts`, `leader.ts`, `follower.ts`, `election.ts`, `node.ts`) and multi-file `fileKey` routing | Copy/adapt only the transport core into `packages/server/src/transport/` and record the exact upstream commit SHA in `packages/server/UPSTREAM.md`. Do **not** import its ~55 predefined tools. |
| [LucasGorgal/localfig](https://github.com/LucasGorgal/localfig) | `figma.commitUndo()` checkpointing, `helpers` runtime utilities, `~/.figcp/token` loopback secret, `--setup` multi-client installer | Re-implement cleanly under TDD in `packages/plugin/src/helpers.ts`, `packages/server/src/auth.ts`, and `packages/server/src/cli/setup.ts`. |
| [southleft/figma-console-mcp](https://github.com/southleft/figma-console-mcp) | QuickJS-safe `eval` wrapper, `console.*` capture, `error.stack` serialization, `resultAnalysis` empty-result warnings | Implement cleanly under TDD in `packages/plugin/src/executor.ts`. |
| [Zfinix/figma-bridge](https://github.com/Zfinix/figma-bridge) | Deterministic bounding-box layout analysis (overflow, sibling overlap, near-miss alignment) | Implement as pure, Figma-independent functions in `packages/linter/src/` so they are 100% unit-testable in Bun. |

---

## 2. Phase Roadmap

Execute these plans strictly in order. Do not start Phase `N+1` until all tests and exit gates of Phase `N` pass.

1. **[Phase 1: Monorepo & Transport Core](./01-monorepo-and-transport.md)**
   - Bun workspace setup, TypeScript base config, `packages/shared` Zod wire schemas.
   - Loopback auth token manager (`~/.figcp/token`).
   - WebSocket Leader/Follower bridge with multi-file `fileKey` registry.
   - Fake Figma Plugin test harness (`tests/helpers/fake-plugin.ts`) + transport integration tests.
2. **[Phase 2: Plugin Executor & 4 MCP Tools](./02-plugin-executor-and-tools.md)**
   - Figma Desktop Plugin (`manifest.json`, `ui.html` WebSocket bridge, `code.ts` worker).
   - Serial execution queue, QuickJS `eval` wrapper, `console.*` capture, `helpers`, and `commitUndo()`.
   - MCP stdio server exposing exactly 4 tools: `run_figma_js`, `inspect_design_system`, `inspect_node_bounds`, `figma_undo`.
   - Full unit + integration tests against the Fake Plugin harness.
3. **[Phase 3: Deterministic DS/RTL Linter, Agent Skill & Real-Figma E2E](./03-ds-linter-skills-and-e2e.md)**
   - `packages/linter`: pure geometry/overflow/overlap + unbound token/style + RTL text heuristic checks.
   - `packages/skills/figcp/SKILL.md`: Agent playbook for Pipeline 1 (inspect → execute → lint/screenshot → fix).
   - CLI `figcp --setup` to register MCP config across Cursor, Claude Code, Codex, and OpenCode.
   - Live Figma Desktop acceptance test suite (including `IRANSansXFaNum` & 16-variant RTL Search Box).

---

## 3. Global Definition of Done (Every Phase)

Before marking any phase complete, run and confirm zero failures:
```bash
npm run typecheck
npm test
npm run build
```
