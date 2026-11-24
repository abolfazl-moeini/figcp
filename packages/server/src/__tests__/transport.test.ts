import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import WebSocket from "ws";
import { FakeFigmaPlugin } from "../../../../tests/helpers/fake-plugin.ts";
import { FollowerClient } from "../transport/follower.ts";
import { TransportNode } from "../transport/node.ts";

const TEST_TOKEN = "abcdef0123456789abcdef0123456789";

describe("TransportNode (Leader/Follower + multi-file routing)", () => {
  it("rejects unauthorized /ws and /rpc requests with 401", async () => {
    const node = new TransportNode({ port: 0, token: TEST_TOKEN });
    await node.start();
    try {
      const rpcRes = await fetch(`http://127.0.0.1:${node.port}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "ping" }),
      });
      assert.equal(rpcRes.status, 401);

      const wsRejected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${node.port}/ws?token=wrong`);
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode === 401));
        ws.once("open", () => {
          ws.close();
          resolve(false);
        });
      });
      assert.equal(wsRejected, true);
    } finally {
      await node.stop();
    }
  });

  it("routes single-file and multi-file commands accurately and enforces disambiguation", async () => {
    const node = new TransportNode({ port: 0, token: TEST_TOKEN });
    await node.start();

    const pluginA = new FakeFigmaPlugin({ port: node.port, token: TEST_TOKEN, fileKey: "fileA", fileName: "App UI" });
    const pluginB = new FakeFigmaPlugin({ port: node.port, token: TEST_TOKEN, fileKey: "fileB", fileName: "DS Kit" });

    try {
      await pluginA.connect();
      const resA = await node.sendCommand({ method: "ping" });
      assert.equal(resA.ok, true);
      if (resA.ok) {
        assert.deepEqual((resA.result as { fileKey: string }).fileKey, "fileA");
      }

      await pluginB.connect();
      await assert.rejects(() => node.sendCommand({ method: "ping" }), /Multiple Figma files are connected/);

      const resB = await node.sendCommand({ method: "ping", fileKey: "fileB" });
      assert.equal(resB.ok, true);
      if (resB.ok) {
        assert.equal((resB.result as { fileKey: string }).fileKey, "fileB");
      }
    } finally {
      await pluginA.disconnect();
      await pluginB.disconnect();
      await node.stop();
    }
  });

  it("times out hung plugin calls cleanly", async () => {
    const node = new TransportNode({ port: 0, token: TEST_TOKEN });
    await node.start();
    const hungPlugin = new FakeFigmaPlugin({
      port: node.port,
      token: TEST_TOKEN,
      fileKey: "hung",
      fileName: "Hung File",
      onCommand: () => new Promise(() => {}),
    });

    try {
      await hungPlugin.connect();
      await assert.rejects(
        () => node.sendCommand({ method: "ping", timeoutMs: 80 }),
        /timed out after 80ms/,
      );
    } finally {
      await hungPlugin.disconnect();
      await node.stop();
    }
  });

  it("supports Leader/Follower proxying and automatic Leader takeover", async () => {
    const leader = new TransportNode({ port: 0, token: TEST_TOKEN });
    await leader.start();
    const port = leader.port;
    assert.equal(leader.role, "leader");

    const follower = new TransportNode({ port, token: TEST_TOKEN, takeoverReconnectWaitMs: 0 });
    await follower.start();
    assert.equal(follower.role, "follower");

    const plugin = new FakeFigmaPlugin({ port, token: TEST_TOKEN, fileKey: "shared", fileName: "Shared File" });
    try {
      await plugin.connect();
      const proxied = await follower.sendCommand({ method: "ping" });
      assert.equal(proxied.ok, true);

      // Kill leader and verify follower takes over
      await leader.stop();
      const filesAfterTakeover = await follower.listConnectedFiles();
      assert.equal(follower.role, "leader");
      assert.deepEqual(filesAfterTakeover, []);
    } finally {
      await plugin.disconnect();
      await leader.stop();
      await follower.stop();
    }
  });

  it("validates HTTP /rpc bodies, rejects non-figcp /ping, rejects schema-invalid plugin responses, and cleans up replaced sockets", async () => {
    const node = new TransportNode({ port: 0, token: TEST_TOKEN });
    await node.start();

    // Non-figcp HTTP 200 server on /ping must fail FollowerClient.ping()
    const decoy = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => decoy.listen(0, "127.0.0.1", resolve));
    const decoyAddr = decoy.address() as { port: number };

    try {
      const decoyFollower = new FollowerClient({ port: decoyAddr.port, token: TEST_TOKEN });
      assert.equal(await decoyFollower.ping(), false);

      // Invalid /rpc body returns HTTP 400
      const badRpc = await fetch(`http://127.0.0.1:${node.port}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ method: "invalid_method" }),
      });
      assert.equal(badRpc.status, 400);

      // Schema-invalid rpc_response rejects immediately instead of timing out
      const rawWs = new WebSocket(`ws://127.0.0.1:${node.port}/ws?token=${encodeURIComponent(TEST_TOKEN)}`);
      await new Promise<void>((resolve) => rawWs.once("open", resolve));
      rawWs.send(
        JSON.stringify({
          type: "hello",
          fileKey: "bad-res-file",
          fileName: "Bad Res",
          pageName: "P1",
          pluginVersion: "0.1.0",
        }),
      );
      await new Promise((r) => setTimeout(r, 25));

      rawWs.once("message", (msg) => {
        const req = JSON.parse(msg.toString("utf8")) as { id: string };
        rawWs.send(
          JSON.stringify({
            type: "rpc_response",
            id: req.id,
            ok: true,
            result: null,
            logs: [{ level: "log", args: [null] }],
          }),
        );
      });

      await assert.rejects(
        () => node.sendCommand({ method: "ping", fileKey: "bad-res-file", timeoutMs: 2000 }),
        /Invalid rpc_response/,
      );

      // Replacing a socket rejects pending requests on the replaced socket immediately
      const pendingCall = node.sendCommand({ method: "ping", fileKey: "bad-res-file", timeoutMs: 5000 });
      const replacementWs = new WebSocket(`ws://127.0.0.1:${node.port}/ws?token=${encodeURIComponent(TEST_TOKEN)}`);
      await new Promise<void>((resolve) => replacementWs.once("open", resolve));
      replacementWs.send(
        JSON.stringify({
          type: "hello",
          fileKey: "bad-res-file",
          fileName: "Bad Res",
          pageName: "P1",
          pluginVersion: "0.1.0",
        }),
      );
      await assert.rejects(() => pendingCall, /was replaced/);
      rawWs.close();
      replacementWs.close();
    } finally {
      await new Promise<void>((resolve) => decoy.close(() => resolve()));
      await node.stop();
    }
  });
});
