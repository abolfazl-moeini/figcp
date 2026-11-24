# `figcp`

> **TL;DR:** Local-first, zero-quota **Figma Desktop Plugin + MCP stdio bridge**. Lets AI coding agents read tokens, create components/variants, run deterministic DS/RTL lint checks, capture screenshots, and undo changes directly inside Figma Desktop (Starter plan compatible, local OS fonts supported, no Figma PAT/REST API needed).

## Requirements

- **Node.js `>= 22.0.0`**
- **Figma Desktop**

## Quick Start

```bash
npm install
npm run build
node packages/server/dist/index.js --setup
```

1. In Figma Desktop, open your file and go to **Plugins → Development → Import plugin from manifest...**
2. Select `~/.figcp/plugin/manifest.json` (run `node packages/server/dist/index.js --print-path` to print the path).
3. Run the **figcp** plugin in Figma Desktop and restart/reload your MCP client.

`--setup` installs the plugin with a baked loopback token (`~/.figcp/token`) and merges `figcp` into existing MCP configs (creating `.figcp.bak` backups):
- **Cursor**: `~/.cursor/mcp.json` (`type: "stdio"`)
- **Claude Code**: `~/.claude.json` (`mcpServers.figcp`)
- **OpenCode**: `~/.config/opencode/opencode.json` (`mcp.servers.figcp`)

Use `--dry-run` to preview `--setup` without writing files.

## MCP Tools (4 Total)

| Tool | Purpose |
| :--- | :--- |
| `inspect_design_system` | Reads Local Variable Collections (resolved aliases), Paint/Text/Effect Styles, Component Sets, and local fonts (e.g. `fontQuery: "IRANSans"`). |
| `run_figma_js` | Executes async Figma Plugin API JS in a serial queue with `figma` and `helpers` in scope, captures `console.*` and stack traces, and checkpoints `commitUndo()`. |
| `inspect_node_bounds` | Returns node geometry, Auto Layout, bound variables, deterministic DS/RTL `lintIssues` (overflow, overlap, unbound fills/strokes/spacing, RTL alignment), and optional inline PNG screenshot. |
| `figma_undo` | Reverts the last checkpointed step (`action: "undo"`) or saves a named version snapshot (`action: "snapshot"`). |

## Architecture

- **`packages/shared`** — Zod wire schemas, RPC types, and `normalizeNodeId`.
- **`packages/server`** — MCP stdio server, loopback auth (`~/.figcp/token`), and `127.0.0.1:1994` WebSocket Leader/Follower bridge with multi-file `fileKey` routing.
- **`packages/plugin`** — Figma QuickJS worker (`SerialPluginExecutor`, `helpers`, inspectors) + WebSocket UI bridge.
- **`packages/linter`** — Pure geometry, token-binding, and Persian/RTL lint rules.
- **`packages/skills/figcp/SKILL.md`** — Closed-loop agent playbook.

## Development

```bash
npm run typecheck
npm test
npm run build
```
