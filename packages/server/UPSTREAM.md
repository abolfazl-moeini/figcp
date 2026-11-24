# Upstream Architectural References

`figcp` uses a clean-room TDD implementation inspired by verified patterns from open-source Figma MCP bridges:

- **Leader/Follower HTTP+WebSocket Transport & Multi-File `fileKey` Routing**: Inspired by `gethopp/figma-mcp-bridge` (`v0.0.27`, https://github.com/gethopp/figma-mcp-bridge) → implemented in `packages/server/src/transport/{bridge,leader,follower,node}.ts`.
- **Loopback Shared-Secret Auth, `commitUndo()` Checkpointing & `--setup` CLI**: Inspired by `LucasGorgal/localfig` (`v0.4.1`, https://github.com/LucasGorgal/localfig) → implemented in `packages/server/src/auth.ts`, `packages/server/src/cli/setup.ts`, and `packages/plugin/src/helpers.ts`.
- **QuickJS-Safe `eval` Async Wrapper & Console Capture**: Inspired by `southleft/figma-console-mcp` (`v1.46.0`, https://github.com/southleft/figma-console-mcp) → implemented in `packages/plugin/src/executor.ts`.
- **Deterministic Bounding-Box Overflow & Overlap Checks**: Inspired by `Zfinix/figma-bridge` (https://github.com/Zfinix/figma-bridge) → implemented in `packages/linter/src/rules.ts`.
