import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TransportNode } from "../../packages/server/src/transport/node.ts";
import { FakeFigmaPlugin } from "../helpers/fake-plugin.ts";

describe("E2E FakeFigmaPlugin smoke", () => {
  it("connects, responds to ping, disconnects, and reconnects cleanly", async () => {
    const token = "11112222333344445555666677778888";
    const node = new TransportNode({ port: 0, token });
    await node.start();
    const plugin = new FakeFigmaPlugin({
      port: node.port,
      token,
      fileKey: "smoke-1",
      fileName: "Smoke Test File",
    });

    try {
      await plugin.connect();
      assert.equal((await node.listConnectedFiles()).length, 1);

      const res = await node.sendCommand({ method: "ping" });
      assert.equal(res.ok, true);

      await plugin.disconnect();
      assert.equal((await node.listConnectedFiles()).length, 0);

      await plugin.connect();
      assert.equal((await node.listConnectedFiles()).length, 1);
    } finally {
      await plugin.disconnect();
      await node.stop();
    }
  });
});
