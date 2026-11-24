#!/usr/bin/env node
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getOrCreateToken, resolveFigcpHome } from "./auth.ts";
import { runSetup } from "./cli/setup.ts";
import { createFigcpMcpServer } from "./mcp.ts";
import { TransportNode } from "./transport/node.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write(
      [
        "figcp — Local Figma Design-System MCP Bridge",
        "",
        "Usage:",
        "  figcp               Start MCP stdio server + local WebSocket bridge",
        "  figcp --setup       Install plugin files to ~/.figcp/plugin/ and register MCP clients",
        "  figcp --dry-run     Preview --setup changes without writing files",
        "  figcp --print-path  Print the Figma plugin manifest.json path",
      ].join("\n") + "\n",
    );
    return;
  }

  if (args.includes("--print-path")) {
    process.stderr.write(`${join(resolveFigcpHome(), "plugin", "manifest.json")}\n`);
    return;
  }

  if (args.includes("--setup") || args.includes("--dry-run")) {
    const dryRun = args.includes("--dry-run");
    const result = runSetup({ dryRun });
    process.stderr.write(
      JSON.stringify(
        {
          status: dryRun ? "dry_run" : "installed",
          manifestPath: result.manifestPath,
          updatedClients: result.updatedClients,
          skippedClients: result.skippedClients,
          nextStep: `In Figma Desktop: Plugins -> Development -> Import plugin from manifest... -> ${result.manifestPath}`,
        },
        null,
        2,
      ) + "\n",
    );
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
