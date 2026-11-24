import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HttpRpcBodySchema,
  InspectNodeBoundsResultSchema,
  NodeBoundsSummarySchema,
  normalizeNodeId,
  PingResponseSchema,
  PluginHelloMessageSchema,
  RpcRequestSchema,
  RpcResponseSchema,
} from "../protocol.ts";

describe("@figcp/shared protocol", () => {
  it("parses valid PluginHelloMessage", () => {
    const parsed = PluginHelloMessageSchema.parse({
      type: "hello",
      fileKey: "abc123",
      fileName: "Design System",
      pageName: "Components",
      pluginVersion: "0.1.0",
    });
    assert.equal(parsed.fileKey, "abc123");
    assert.equal(parsed.fileName, "Design System");
  });

  it("rejects malformed RpcRequest", () => {
    assert.throws(() =>
      RpcRequestSchema.parse({
        type: "rpc_request",
        id: "",
        method: "unknown_method",
        timeoutMs: -10,
      }),
    );
  });

  it("parses RpcResponse success and error variants", () => {
    const ok = RpcResponseSchema.parse({
      type: "rpc_response",
      id: "req_1",
      ok: true,
      result: { id: "1:2" },
      logs: [{ level: "log", args: ["created"] }],
    });
    assert.equal(ok.ok, true);

    const fail = RpcResponseSchema.parse({
      type: "rpc_response",
      id: "req_2",
      ok: false,
      error: { name: "Error", message: "boom", stack: "Error: boom\n at eval" },
      logs: [{ level: "error", args: ["failed"] }],
    });
    assert.equal(fail.ok, false);
    if (!fail.ok) {
      assert.equal(fail.error.message, "boom");
    }
  });

  it("normalizeNodeId converts dash format to colon format", () => {
    assert.equal(normalizeNodeId("5031-4449"), "5031:4449");
    assert.equal(normalizeNodeId("5031:4449"), "5031:4449");
    assert.equal(normalizeNodeId(" 12-34 "), "12:34");
  });

  it("validates HttpRpcBodySchema, NodeBoundsSummarySchema (including GRID), and PingResponseSchema", () => {
    const rpcBody = HttpRpcBodySchema.parse({ method: "ping" });
    assert.deepEqual(rpcBody.params, {});

    const bounds = InspectNodeBoundsResultSchema.parse({
      node: {
        id: "1:1",
        name: "GridFrame",
        type: "FRAME",
        layoutMode: "GRID",
        truncatedChildrenCount: 2,
      },
    });
    assert.equal(bounds.node.layoutMode, "GRID");
    assert.equal(bounds.node.truncatedChildrenCount, 2);
    assert.ok(NodeBoundsSummarySchema.safeParse(bounds.node).success);
    assert.ok(PingResponseSchema.safeParse({ ok: true, service: "figcp", role: "leader" }).success);
    assert.equal(PingResponseSchema.safeParse({ ok: true }).success, false);
  });
});
