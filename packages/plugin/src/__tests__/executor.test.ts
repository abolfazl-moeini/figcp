import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SerialPluginExecutor } from "../executor.ts";

describe("SerialPluginExecutor", () => {
  it("executes async code, captures logs, and commits undo on success", async () => {
    let undoCommitted = 0;
    const mockFigma = {
      commitUndo: () => {
        undoCommitted++;
      },
    };
    const executor = new SerialPluginExecutor();
    const res = await executor.execute(
      `console.log("hello", 123);
       console.warn("careful");
       console.error("minor");
       return await Promise.resolve({ answer: 42 });`,
      mockFigma,
      {},
    );

    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.result, { answer: 42 });
      assert.equal(res.logs.length, 3);
      assert.equal(res.logs[0]?.level, "log");
      assert.equal(res.logs[1]?.level, "warn");
      assert.equal(res.logs[2]?.level, "error");
    }
    assert.equal(undoCommitted, 1);
  });

  it("captures thrown errors + stack trace and skips commitUndo", async () => {
    let undoCommitted = 0;
    const mockFigma = {
      commitUndo: () => {
        undoCommitted++;
      },
    };
    const executor = new SerialPluginExecutor();
    const res = await executor.execute(`console.log("before"); throw new Error("boom");`, mockFigma, {});

    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.message, "boom");
      assert.ok(typeof res.error.stack === "string" && res.error.stack.includes("boom"));
      assert.equal(res.logs.length, 1);
    }
    assert.equal(undoCommitted, 0);
  });

  it("serializes concurrent executions without cross-contaminating logs", async () => {
    const executor = new SerialPluginExecutor();
    const p1 = executor.execute(
      `console.log("first-start");
       await new Promise(r => setTimeout(r, 40));
       console.log("first-end");
       return 1;`,
      {},
      {},
    );
    const p2 = executor.execute(`console.log("second"); return 2;`, {}, {});

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.deepEqual(
      r1.logs.map((l) => l.args[0]),
      ["first-start", "first-end"],
    );
    assert.deepEqual(
      r2.logs.map((l) => l.args[0]),
      ["second"],
    );
  });

  it("safely collapses circular Figma-like SceneNodes", async () => {
    const executor = new SerialPluginExecutor();
    const res = await executor.execute(
      `const parent = { id: "0:1", name: "Page 1", type: "PAGE", parent: null };
       const child = { id: "1:2", name: "Button", type: "FRAME", parent };
       parent.children = [child];
       return child;`,
      {},
      {},
    );

    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.result, { id: "1:2", name: "Button", type: "FRAME" });
    }
  });

  it("enforces timeoutMs and keeps queue usable afterwards", async () => {
    const executor = new SerialPluginExecutor();
    const hung = await executor.execute(`await new Promise(() => {});`, {}, {}, { timeoutMs: 60 });
    assert.equal(hung.ok, false);
    if (!hung.ok) {
      assert.match(hung.error.message, /timed out after 60ms/);
    }

    const followUp = await executor.execute(`return "recovered";`, {}, {});
    assert.equal(followUp.ok, true);
    if (followUp.ok) {
      assert.equal(followUp.result, "recovered");
    }
  });

  it("serializes undefined, function, and symbol console args as strings", async () => {
    const executor = new SerialPluginExecutor();
    const res = await executor.execute(
      `console.log(undefined, () => {}, Symbol("tok")); return true;`,
      {},
      {},
    );
    assert.equal(res.ok, true);
    assert.deepEqual(res.logs[0]?.args, ["undefined", "[Function: anonymous]", "Symbol(tok)"]);
  });

  it("blocks post-timeout figma mutations and log contamination from timed-out async code", async () => {
    let createdAfterTimeout = 0;
    let undoCommitted = 0;
    const mockFigma = {
      createFrame: () => {
        createdAfterTimeout++;
        return { id: "9:9", type: "FRAME" };
      },
      commitUndo: () => {
        undoCommitted++;
      },
    };
    const executor = new SerialPluginExecutor();
    const timedOut = await executor.execute(
      `await new Promise(r => setTimeout(r, 80));
       console.log("late-log");
       figma.createFrame();`,
      mockFigma,
      {},
      { timeoutMs: 25 },
    );
    assert.equal(timedOut.ok, false);

    const next = await executor.execute(
      `await new Promise(r => setTimeout(r, 90));
       console.log("clean-log");
       return "ok";`,
      mockFigma,
      {},
    );
    assert.equal(next.ok, true);
    assert.equal(createdAfterTimeout, 0);
    assert.equal(undoCommitted, 1);
    assert.deepEqual(
      next.logs.map((l) => l.args[0]),
      ["clean-log"],
    );
  });

  it("commits undo on mutate-then-throw so partial mutations remain revertible", async () => {
    let undoCommitted = 0;
    const mockFigma = {
      createFrame: () => ({ id: "1:1", type: "FRAME" }),
      commitUndo: () => {
        undoCommitted++;
      },
    };
    const executor = new SerialPluginExecutor();
    const res = await executor.execute(
      `figma.createFrame(); throw new Error("halfway failure");`,
      mockFigma,
      {},
    );
    assert.equal(res.ok, false);
    assert.equal(undoCommitted, 1);
  });

  it("serializes runTask alongside execute calls", async () => {
    const order: string[] = [];
    const executor = new SerialPluginExecutor();
    const p1 = executor.execute(
      `await new Promise(r => setTimeout(r, 30)); return "exec";`,
      {},
      {},
    ).then((r) => {
      order.push("execute");
      return r;
    });
    const p2 = executor.runTask(() => {
      order.push("task");
      return "inspected";
    });
    const [, tRes] = await Promise.all([p1, p2]);
    assert.equal(tRes, "inspected");
    assert.deepEqual(order, ["execute", "task"]);
  });
});
