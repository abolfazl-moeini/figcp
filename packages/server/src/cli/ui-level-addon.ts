import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolveFigcpHome } from "../auth.ts";
import { mergeJsonMcpConfig, mergeTomlServerEntry } from "./setup.ts";

export type UiLevelState = "disabled" | "enabled" | "declined";

export interface FigcpConfig {
  uiLevel?: UiLevelState;
}

export function detectUiLevel(): boolean {
  const explicit = process.env.UI_LEVEL_PATH;
  if (explicit && existsSync(explicit)) {
    return true;
  }

  const localBin = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "ui-level.cmd" : "ui-level",
  );
  if (existsSync(localBin)) {
    return true;
  }

  const pathEnv = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, `ui-level${ext}`))) {
        return true;
      }
    }
  }
  return false;
}

export function getUiLevelConfig(figcpHome = resolveFigcpHome()): FigcpConfig {
  const cfgPath = join(figcpHome, "config.json");
  if (existsSync(cfgPath)) {
    try {
      const data = JSON.parse(readFileSync(cfgPath, "utf8"));
      if (typeof data === "object" && data !== null) {
        return data as FigcpConfig;
      }
    } catch {
      // Ignored
    }
  }
  return { uiLevel: "disabled" };
}

export function setUiLevelConfig(state: UiLevelState, figcpHome = resolveFigcpHome()): void {
  mkdirSync(figcpHome, { recursive: true, mode: 0o700 });
  const cfgPath = join(figcpHome, "config.json");
  const existing = getUiLevelConfig(figcpHome);
  existing.uiLevel = state;
  writeFileSync(cfgPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

export interface RegisterUiLevelOptions {
  homeDir?: string;
  dryRun?: boolean;
}

export interface RegisterUiLevelResult {
  updatedClients: string[];
  skippedClients: string[];
}

export function registerUiLevelMcpClients(options: RegisterUiLevelOptions = {}): RegisterUiLevelResult {
  const userHome = options.homeDir ?? homedir();
  const dryRun = options.dryRun ?? false;

  const stdioEntry = {
    type: "stdio",
    command: "npx",
    args: ["-y", "ui-level", "mcp"],
  };

  const opencodeEntry = {
    type: "local",
    command: ["npx", "-y", "ui-level", "mcp"],
  };

  const hasClaude =
    existsSync(join(userHome, ".claude.json")) || existsSync(join(userHome, ".claude"));

  const targets: Array<{
    name: string;
    path: string;
    sectionPath: readonly string[];
    value: unknown;
  }> = [
    { name: "Cursor", path: join(userHome, ".cursor", "mcp.json"), sectionPath: ["mcpServers"], value: stdioEntry },
    {
      name: "Antigravity",
      path: join(userHome, ".gemini", "antigravity", "mcp_config.json"),
      sectionPath: ["mcpServers"],
      value: stdioEntry,
    },
    ...(hasClaude
      ? [
          {
            name: "Claude Code",
            path: join(userHome, ".claude.json"),
            sectionPath: ["mcpServers"],
            value: stdioEntry,
          },
        ]
      : []),
    {
      name: "OpenCode",
      path: join(userHome, ".config", "opencode", "opencode.json"),
      sectionPath: ["mcp", "servers"],
      value: opencodeEntry,
    },
  ];

  const updatedClients: string[] = [];
  const skippedClients: string[] = [];

  for (const target of targets) {
    const status = mergeJsonMcpConfig(
      target.path,
      target.sectionPath,
      "ui-level",
      target.value,
      dryRun,
    );
    if (status === "updated") {
      updatedClients.push(`${target.name} (${target.path})`);
    } else {
      skippedClients.push(target.name);
    }
  }

  const hasCodex =
    existsSync(join(userHome, ".codex", "config.toml")) || existsSync(join(userHome, ".codex"));
  if (hasCodex) {
    const codexPath = join(userHome, ".codex", "config.toml");
    const codexStatus = mergeTomlServerEntry(
      codexPath,
      "ui-level",
      "npx",
      ["-y", "ui-level", "mcp"],
      {},
      dryRun,
    );
    if (codexStatus === "updated") {
      updatedClients.push(`Codex CLI (${codexPath})`);
    } else {
      skippedClients.push("Codex CLI");
    }
  }

  return { updatedClients, skippedClients };
}

export function enableUiLevelAddon(
  figcpHome = resolveFigcpHome(),
  options: {
    installPackage?: boolean;
    homeDir?: string;
    dryRun?: boolean;
    npmTag?: string;
  } = {},
): {
  ok: boolean;
  installed: boolean;
  message: string;
  updatedClients: string[];
} {
  let installed = detectUiLevel();
  const pkgTarget = options.npmTag ? `ui-level@${options.npmTag}` : "ui-level";

  if (!installed && options.installPackage) {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const installRes = spawnSync(npmCmd, ["install", "-g", pkgTarget], {
      stdio: "inherit",
    });
    if (installRes.status === 0) {
      installed = detectUiLevel();
    } else {
      setUiLevelConfig("enabled", figcpHome);
      return {
        ok: false,
        installed: false,
        message: `Failed to install \`${pkgTarget}\` globally via npm. Enabled in config; install manually with \`npm install -g ${pkgTarget}\`.`,
        updatedClients: [],
      };
    }
  }

  setUiLevelConfig("enabled", figcpHome);
  const clientReg = registerUiLevelMcpClients({ homeDir: options.homeDir, dryRun: options.dryRun });

  const clientMsg =
    clientReg.updatedClients.length > 0
      ? ` Registered "ui-level" in MCP clients: ${clientReg.updatedClients.join(", ")}.`
      : "";

  if (installed) {
    return {
      ok: true,
      installed: true,
      message: `ui-level integration enabled from npm (https://www.npmjs.com/package/ui-level).${clientMsg}`,
      updatedClients: clientReg.updatedClients,
    };
  }

  return {
    ok: true,
    installed: false,
    message: `ui-level enabled in config.${clientMsg} Note: ui-level binary not detected on PATH. Install it via \`npm install -g ui-level\` or run \`npx -y ui-level mcp\`.`,
    updatedClients: clientReg.updatedClients,
  };
}
