import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runDoctor } from "../cli/doctor.ts";
import { runSetup } from "../cli/setup.ts";

describe("CLI --setup installer", () => {
  it("writes plugin files with baked token/port and merges MCP client configs (Cursor stdio + OpenCode V2) with preserved backups", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "figcp-setup-"));
    const fakeDist = mkdtempSync(join(tmpdir(), "figcp-dist-"));

    try {
      // Prepare fake plugin dist
      writeFileSync(join(fakeDist, "manifest.json"), JSON.stringify({ name: "figcp", port: "1994" }), "utf8");
      writeFileSync(join(fakeDist, "code.js"), "// compiled code", "utf8");
      writeFileSync(join(fakeDist, "ui.template.html"), "PORT=__FIGCP_PORT__;TOKEN=__FIGCP_TOKEN__", "utf8");

      // Prepare existing Cursor & OpenCode V1/V2 configs
      mkdirSync(join(fakeHome, ".cursor"), { recursive: true });
      const originalCursor = JSON.stringify({ mcpServers: { existing: { command: "echo" } } });
      writeFileSync(join(fakeHome, ".cursor", "mcp.json"), originalCursor, "utf8");

      mkdirSync(join(fakeHome, ".config", "opencode"), { recursive: true });
      writeFileSync(
        join(fakeHome, ".config", "opencode", "opencode.json"),
        JSON.stringify({
          mcp: {
            figcp: { type: "local", command: ["old"] },
            servers: { other: { type: "local", command: ["echo"] } },
          },
        }),
        "utf8",
      );

      // Prepare Claude Code dir
      writeFileSync(join(fakeHome, ".claude.json"), JSON.stringify({ mcpServers: {} }), "utf8");

      // Prepare Codex CLI dir & config.toml
      mkdirSync(join(fakeHome, ".codex"), { recursive: true });
      writeFileSync(join(fakeHome, ".codex", "config.toml"), 'model = "gpt-5"\n', "utf8");

      // 1. Dry-run writes nothing
      const dry = runSetup({ homeDir: fakeHome, pluginDistDir: fakeDist, dryRun: true });
      assert.equal(dry.dryRun, true);
      assert.equal(existsSync(join(fakeHome, ".figcp", "token")), false);

      // 2. Real setup writes plugin + merges configs + creates backups
      const res = runSetup({ homeDir: fakeHome, pluginDistDir: fakeDist, port: 2026 });
      assert.equal(existsSync(res.tokenPath), true);
      assert.equal(existsSync(join(res.pluginDir, "code.js")), true);
      assert.equal(existsSync(join(res.pluginDir, "ui.html")), true);

      const uiMode = statSync(join(res.pluginDir, "ui.html")).mode & 0o777;
      assert.equal(uiMode, 0o600);

      const token = readFileSync(res.tokenPath, "utf8").trim();
      const uiHtml = readFileSync(join(res.pluginDir, "ui.html"), "utf8");
      assert.ok(uiHtml.includes("PORT=2026"));
      assert.ok(uiHtml.includes(`TOKEN=${token}`));

      assert.equal(existsSync(join(fakeHome, ".cursor", "mcp.json.figcp.bak")), true);
      const cursorCfg = JSON.parse(readFileSync(join(fakeHome, ".cursor", "mcp.json"), "utf8"));
      assert.ok(cursorCfg.mcpServers.existing);
      assert.equal(cursorCfg.mcpServers.figcp.type, "stdio");

      const claudeCfg = JSON.parse(readFileSync(join(fakeHome, ".claude.json"), "utf8"));
      assert.equal(claudeCfg.mcpServers.figcp.type, "stdio");

      assert.equal(existsSync(join(fakeHome, ".codex", "config.toml.figcp.bak")), true);
      const codexToml = readFileSync(join(fakeHome, ".codex", "config.toml"), "utf8");
      assert.ok(codexToml.includes('[mcp_servers.figcp]'));
      assert.ok(codexToml.includes('FIGCP_PORT = "2026"'));
      assert.ok(codexToml.includes('model = "gpt-5"'));

      const ocCfg = JSON.parse(readFileSync(join(fakeHome, ".config", "opencode", "opencode.json"), "utf8"));
      assert.ok(ocCfg.mcp.servers.other);
      assert.equal(ocCfg.mcp.servers.figcp.type, "local");
      assert.equal("figcp" in ocCfg.mcp, false);

      // 3. Re-running setup preserves original .figcp.bak
      runSetup({ homeDir: fakeHome, pluginDistDir: fakeDist, port: 2027 });
      assert.equal(readFileSync(join(fakeHome, ".cursor", "mcp.json.figcp.bak"), "utf8"), originalCursor);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(fakeDist, { recursive: true, force: true });
    }
  });

  it("throws when plugin artifacts are missing and skips null/non-object client configs", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "figcp-setup-err-"));
    const emptyDist = mkdtempSync(join(tmpdir(), "figcp-dist-empty-"));
    const validDist = mkdtempSync(join(tmpdir(), "figcp-dist-ok-"));

    try {
      assert.throws(
        () => runSetup({ homeDir: fakeHome, pluginDistDir: emptyDist }),
        /Missing built plugin artifact/,
      );

      writeFileSync(join(validDist, "manifest.json"), "{}", "utf8");
      writeFileSync(join(validDist, "code.js"), "", "utf8");
      writeFileSync(join(validDist, "ui.template.html"), "", "utf8");

      mkdirSync(join(fakeHome, ".cursor"), { recursive: true });
      writeFileSync(join(fakeHome, ".cursor", "mcp.json"), "null", "utf8");

      const res = runSetup({ homeDir: fakeHome, pluginDistDir: validDist });
      assert.ok(res.skippedClients.includes("Cursor"));
      assert.equal(readFileSync(join(fakeHome, ".cursor", "mcp.json"), "utf8"), "null");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(emptyDist, { recursive: true, force: true });
      rmSync(validDist, { recursive: true, force: true });
    }
  });

  it("diagnoses environment health via runDoctor", async () => {
    const report = await runDoctor();
    assert.ok(Array.isArray(report.checks));
    assert.ok(report.checks.some((c) => c.name === "Node.js Runtime" && c.ok));
    assert.ok(report.checks.some((c) => c.name === "Bridge Health"));
  });
});
