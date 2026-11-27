#!/usr/bin/env node
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getOrCreateToken, resolveFigcpHome } from "./auth.ts";
import { runDoctor } from "./cli/doctor.ts";
import { runSetup } from "./cli/setup.ts";
import { enableUiLevelAddon, getUiLevelConfig, setUiLevelConfig } from "./cli/ui-level-addon.ts";
import { createFigcpMcpServer } from "./mcp.ts";
import { WebCaptureManager } from "./web-capture/capture-manager.ts";
import { generateFigmaImportScript } from "./web-capture/figma-builder.ts";
import { TransportNode } from "./transport/node.ts";

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const withUiLevel = args.includes("--enable-ui-level") || args.includes("--with-ui-level");
  const installUiLevel = args.includes("--install-ui-level");
  const isSetup = args.includes("--setup") || args.includes("--dry-run") || args.includes("--install-skill");

  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write(
      [
        "figcp — Local Figma Design-System MCP Bridge",
        "",
        "Usage:",
        "  figcp                  Start MCP stdio server + local WebSocket bridge",
        "  figcp --setup          Install plugin files to ~/.figcp/plugin/ and register MCP clients",
        "  figcp --doctor         Diagnose local Node, plugin, token, port, and client health",
        "  figcp --install-skill  Install figcp SKILL.md to AI coding agents (~/.gemini or ~/.agents)",
        "  figcp --with-ui-level  Enable optional ui-level (npm: ui-level) verification integration",
        "  figcp --install-ui-level Install `ui-level` from npm globally and configure MCP clients",
        "  figcp capture-web <url> Capture a web page and import into Figma",
        "  figcp --no-prompt      Skip optional interactive prompts during --setup",
        "  figcp --dry-run        Preview --setup changes without writing files",
        "  figcp --print-path     Print the Figma plugin manifest.json path",
      ].join("\n") + "\n",
    );
    return;
  }

  if (args[0] === "capture-web") {
    const restArgs = args.slice(1);
    const cdpIdx = restArgs.indexOf("--cdp");
    const cdpEndpoint = cdpIdx !== -1 ? restArgs[cdpIdx + 1] : undefined;
    const captureStates = restArgs.includes("--states");
    const targetUrl = restArgs.find((a, i) => !a.startsWith("--") && (cdpIdx === -1 || i !== cdpIdx + 1));

    const token = getOrCreateToken();
    const port = Number(process.env.FIGCP_PORT || "1994");
    const node = new TransportNode({ port, token });
    try {
      process.stderr.write(`[figcp:capture-web] Connecting to browser CDP to capture ${targetUrl || "active tab"}...\n`);
      const capture = await WebCaptureManager.captureWeb({ url: targetUrl, cdpEndpoint, captureStates });
      process.stderr.write(
        `[figcp:capture-web] Captured "${capture.title}" with ${Object.keys(capture.variables).length} variables and ${capture.fonts.length} fonts.\n`,
      );
      const script = generateFigmaImportScript(capture);

      await node.start();
      const resp = await node.sendCommand({
        method: "run_figma_js",
        params: { code: script },
        timeoutMs: 60000,
      });
      if (!resp.ok) {
        process.stderr.write(`[figcp:capture-web] Error from Figma plugin: ${resp.error?.message || "Unknown error"}\n`);
        process.exitCode = 1;
      } else {
        process.stderr.write(`[figcp:capture-web] Successfully imported into Figma!\n`);
        process.stdout.write(JSON.stringify(resp.result, null, 2) + "\n");
      }
    } catch (err) {
      process.stderr.write(`[figcp:capture-web] Failed: ${(err as Error).message}\n`);
      process.exitCode = 1;
    } finally {
      await node.stop();
    }
    return;
  }

  if (args.includes("--print-path")) {
    process.stderr.write(`${join(resolveFigcpHome(), "plugin", "manifest.json")}\n`);
    return;
  }

  if (args.includes("--doctor")) {
    const report = await runDoctor();
    process.stderr.write(
      JSON.stringify(
        {
          status: report.overallOk ? "healthy" : "issues_detected",
          checks: report.checks,
        },
        null,
        2,
      ) + "\n",
    );
    if (!report.overallOk) {
      process.exitCode = 1;
    }
    return;
  }

  if (isSetup) {
    const dryRun = args.includes("--dry-run");
    const installSkill = args.includes("--install-skill") || args.includes("--setup");
    const result = runSetup({ dryRun, installSkill });
    process.stderr.write(
      JSON.stringify(
        {
          status: dryRun ? "dry_run" : "installed",
          manifestPath: result.manifestPath,
          updatedClients: result.updatedClients,
          skippedClients: result.skippedClients,
          installedSkills: result.installedSkills,
          nextStep: `In Figma Desktop: Plugins -> Development -> Import plugin from manifest... -> ${result.manifestPath}`,
        },
        null,
        2,
      ) + "\n",
    );

    if (!dryRun) {
      if (withUiLevel || installUiLevel) {
        const res = enableUiLevelAddon(undefined, { installPackage: installUiLevel });
        process.stderr.write(`${res.message}\n`);
        if (!res.ok) process.exitCode = 1;
      } else if (
        args.includes("--setup") &&
        !args.includes("--no-prompt") &&
        process.stdin.isTTY &&
        process.stdout.isTTY &&
        getUiLevelConfig().uiLevel === "disabled"
      ) {
        const accepted = await promptYesNo(
          "Enable optional ui-level (npm: ui-level) verification for Figma -> Code workflows? [y/N]: ",
        );
        if (accepted) {
          const res = enableUiLevelAddon();
          process.stderr.write(`${res.message}\n`);
        } else {
          setUiLevelConfig("declined");
        }
      }
    }
    return;
  }

  if (withUiLevel || installUiLevel) {
    const res = enableUiLevelAddon(undefined, { installPackage: installUiLevel });
    process.stderr.write(`${res.message}\n`);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  const token = getOrCreateToken();
  const transportNode = new TransportNode({ token });
  await transportNode.start();
  process.stderr.write(
    `[figcp] Started as ${transportNode.role} on 127.0.0.1:${transportNode.port}\n`,
  );

  const mcpServer = createFigcpMcpServer(transportNode);
  const stdioTransport = new StdioServerTransport();
  await mcpServer.connect(stdioTransport);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await mcpServer.close();
    } catch {
      // Ignore MCP close errors during exit
    }
    await transportNode.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
}

main().catch((err) => {
  process.stderr.write(`[figcp] Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
