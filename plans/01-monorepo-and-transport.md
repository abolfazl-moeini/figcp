# Phase 1 Plan: Monorepo Scaffolding, Shared Wire Protocol & Transport Core (TDD)

**Goal:** Build a rock-solid Bun monorepo with strongly typed wire schemas, loopback token authentication, a multi-file WebSocket Leader/Follower bridge, and a Fake Figma Plugin harness so all downstream development is 100% testable without opening Figma Desktop.

**Rules:** Follow Red → Green → Refactor on every task. Run `bun test` after every sub-task.

---

## Task 1.1 — Initialize Bun Monorepo & TypeScript Config

### Steps
1. Create root `package.json`:
   - Configure `"workspaces": ["packages/*"]`.
   - Add scripts: `"typecheck"`, `"test": "bun test"`, `"build"`, `"build:plugin"`, `"build:server"`.
   - Add devDependencies: `typescript`, `@types/bun`, `@figma/plugin-typings`, `zod`, `@modelcontextprotocol/sdk`.
2. Create `tsconfig.base.json`:
   - `"strict": true`, `"noUncheckedIndexedAccess": true`, `"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "bundler"`, `"skipLibCheck": true`.
3. Create skeleton `package.json` and `tsconfig.json` for:
   - `packages/shared` (`@figcp/shared`)
   - `packages/server` (`@figcp/server`)
   - `packages/plugin` (`@figcp/plugin`)
   - `packages/linter` (`@figcp/linter`)
4. Create `.gitignore` ignoring `node_modules/`, `dist/`, `.DS_Store`, `*.log`, `.reference/`.

### Verification
- Run `bun install` and `bun run typecheck` — both exit with code `0`.

---

## Task 1.2 — Shared Wire Protocol & RPC Schemas (`packages/shared`)

### Red (Write Failing Tests First)
Create `packages/shared/src/__tests__/protocol.test.ts`:
- Test parsing valid `PluginHelloMessage` (`{ type: "hello", fileKey, fileName, pageName, pluginVersion }`).
- Test rejecting malformed `RpcRequest` (missing `id`, invalid `method`, negative `timeoutMs`).
- Test parsing `RpcSuccessResponse` and `RpcErrorResponse` (including `logs[]` and `error.stack`).
- Test `normalizeNodeId("5031-4449")` → `"5031:4449"` and preserving `"5031:4449"`.

### Green (Implement)
Create `packages/shared/src/protocol.ts` and `packages/shared/src/index.ts`:
- Define Zod schemas & inferred TypeScript types for:
  - `RpcMethod`: `"run_figma_js" | "inspect_design_system" | "inspect_node_bounds" | "figma_undo" | "ping"`
  - `PluginHelloMessage`, `RpcRequest`, `LogEntry`, `RpcErrorPayload`, `RpcResponse`
  - `NodeBoundsSummary`, `LintIssue`, `DesignSystemSnapshot`
- Implement `normalizeNodeId(id: string): string` (converts `-` to `:` for Figma URL node IDs).

### Verification
- `bun test packages/shared` passes 100%.

---

## Task 1.3 — Loopback Secret Token Manager (`packages/server/src/auth.ts`)

### Red (Write Failing Tests First)
Create `packages/server/src/__tests__/auth.test.ts` (using a temp directory via `FIGCP_HOME` env override):
- Test `getOrCreateToken(homeDir)` generates a 32-char hex token on first call and persists it to `<homeDir>/token` with `0o600` permissions.
- Test calling `getOrCreateToken(homeDir)` a second time returns the exact same token.
- Test `validateAuthToken(provided, expected)` returns `true` for exact match (constant-time comparison) and `false` for missing, empty, or mismatched tokens.

### Green (Implement)
Create `packages/server/src/auth.ts`:
- Use `crypto.randomBytes(16).toString("hex")` and `crypto.timingSafeEqual`.
- Never log the token value to stdout or stderr.

### Verification
- `bun test packages/server/src/__tests__/auth.test.ts` passes 100%.

---

## Task 1.4 — Multi-File WebSocket Bridge & Leader/Follower Election (`packages/server/src/transport/`)

Adapt the Leader/Follower architecture from [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge) into clean, testable TypeScript modules.

### Red (Write Failing Tests First)
Create `packages/server/src/__tests__/transport.test.ts`:
1. **Auth rejection**: Connecting to `/ws` or POSTing to `/rpc` without a valid token returns HTTP `401`.
2. **Single-file routing**: Connect 1 mock WebSocket plugin sending `hello` (`fileKey: "fileA"`). Calling `sendCommand({ method: "ping" })` without `fileKey` routes to `"fileA"` and resolves with the plugin's response.
3. **Multi-file routing**: Connect 2 mock plugins (`"fileA"`, `"fileB"`).
   - Calling `sendCommand({ method: "ping", fileKey: "fileB" })` routes strictly to `"fileB"`.
   - Calling `sendCommand({ method: "ping" })` without `fileKey` when 2 files are connected throws a clear disambiguation error listing both `fileKey`s and `fileName`s.
4. **Timeout handling**: If the mock plugin never replies, `sendCommand` rejects after `timeoutMs` (test with `timeoutMs: 100`) and cleans up the pending request map.
5. **Leader/Follower proxying**:
   - Start Instance 1 on an ephemeral test port → becomes **Leader**.
   - Start Instance 2 on the same port → detects Leader via `/ping`, becomes **Follower**, and proxies `sendCommand` via HTTP `POST /rpc` to Leader → succeeds!
   - Stop Instance 1 (Leader dies) → Instance 2 detects failure and takes over as **Leader** on next command/health tick.

### Green (Implement)
Create inside `packages/server/src/transport/`:
- `bridge.ts`: WebSocket connection registry keyed by `fileKey`, request-ID correlation map, timeout cleanup, and `listConnectedFiles()`.
- `leader.ts`: HTTP + WebSocket server bound strictly to `127.0.0.1` (default port `1994`, overridable via `FIGCP_PORT`). Endpoints: `GET /ping` (health), `GET /ws` (authenticated plugin WS), `POST /rpc` (authenticated follower RPC).
- `follower.ts`: HTTP RPC client forwarding calls to `http://127.0.0.1:<port>/rpc`.
- `node.ts`: Unified `TransportNode` that attempts Leader bind, falls back to Follower if `EADDRINUSE`, and supports automatic takeover if Leader dies.
- Record upstream attribution in `packages/server/UPSTREAM.md`.

### Verification
- `bun test packages/server/src/__tests__/transport.test.ts` passes 100% with zero leaked handles/timers.

---

## Task 1.5 — Fake Figma Plugin Harness (`tests/helpers/fake-plugin.ts`)

### Red (Write Failing Tests First)
Create `tests/e2e/fake-plugin-smoke.test.ts`:
- Boot `TransportNode` on an ephemeral port + connect `FakeFigmaPlugin` over real WebSocket.
- Send a `ping` RPC and verify round-trip response includes `fileKey` and `fileName`.
- Close and reconnect `FakeFigmaPlugin` and verify `listConnectedFiles()` updates cleanly.

### Green (Implement)
Create `tests/helpers/fake-plugin.ts`:
- Connects over real WebSocket to `ws://127.0.0.1:<port>/ws?token=<token>`.
- Sends `PluginHelloMessage` on open.
- Accepts pluggable command handlers (`onCommand(req) => res`) so Phase 2 & 3 tests can simulate real Figma Plugin API responses, errors, timeouts, and PNG exports deterministically.

### Phase 1 Exit Gate
```bash
bun run typecheck
bun test
```
All Phase 1 tests must pass with zero warnings or hanging processes.
