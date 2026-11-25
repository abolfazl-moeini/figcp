import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrCreateToken, resolveFigcpHome } from "../auth.ts";

export interface SetupOptions {
  homeDir?: string;
  figcpHome?: string;
  port?: number;
  dryRun?: boolean;
  pluginDistDir?: string;
  serverEntryPath?: string;
  installSkill?: boolean;
}

export interface SetupResult {
  pluginDir: string;
  manifestPath: string;
  tokenPath: string;
  updatedClients: string[];
  skippedClients: string[];
  installedSkills?: string[];
  dryRun: boolean;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

function defaultPluginDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Running from packages/server/src/cli/setup.ts
    resolve(here, "../../../plugin/dist"),
    // Running from bundled packages/server/dist/index.js
    resolve(here, "../../plugin/dist"),
    // Fallback if executed from repo root dist
    resolve(here, "../packages/plugin/dist"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "manifest.json"))) {
      return candidate;
    }
  }
  return candidates[0]!;
}

function defaultServerEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Running from bundled packages/server/dist/index.js
    resolve(here, "index.js"),
    // Running from packages/server/src/cli/setup.ts
    resolve(here, "../../dist/index.js"),
    // Source fallback
    resolve(here, "../index.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[1]!;
}

function mergeJsonMcpConfig(
  filePath: string,
  sectionPath: readonly string[],
  entryName: string,
  entryValue: unknown,
  dryRun: boolean,
  legacyV1CleanupKey?: string,
): "updated" | "skipped" {
  const parentDir = dirname(filePath);
  if (!existsSync(parentDir)) {
    return "skipped";
  }

  let data: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      return "skipped";
    }
    if (!isPlainObject(parsed)) {
      return "skipped";
    }
    data = parsed;
  }

  // Validate every section along sectionPath is either undefined or a plain object
  const clone: Record<string, unknown> = { ...data };
  let cursor: Record<string, unknown> = clone;

  for (let i = 0; i < sectionPath.length; i++) {
    const key = sectionPath[i]!;
    const existing = cursor[key];
    if (existing !== undefined && !isPlainObject(existing)) {
      return "skipped";
    }
    const nextObj: Record<string, unknown> = existing ? { ...existing } : {};
    if (i === 0 && legacyV1CleanupKey && legacyV1CleanupKey in nextObj) {
      delete nextObj[legacyV1CleanupKey];
    }
    cursor[key] = nextObj;
    cursor = nextObj;
  }

  cursor[entryName] = entryValue;

  if (!dryRun) {
    const bakPath = `${filePath}.figcp.bak`;
    if (existsSync(filePath) && !existsSync(bakPath)) {
      copyFileSync(filePath, bakPath);
    }
    writeFileSync(filePath, `${JSON.stringify(clone, null, 2)}\n`, "utf8");
  }
  return "updated";
}

function mergeTomlMcpConfig(
  filePath: string,
  serverEntry: string,
  nodeBin: string,
  figcpHome: string,
  port: number,
  dryRun: boolean,
): "updated" | "skipped" {
  const parentDir = dirname(filePath);
  if (!existsSync(parentDir)) {
    return "skipped";
  }

  let content = "";
  if (existsSync(filePath)) {
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return "skipped";
    }
  }

  const tomlBlock = `[mcp_servers.figcp]
command = ${JSON.stringify(nodeBin)}
args = [${JSON.stringify(serverEntry)}]

[mcp_servers.figcp.env]
FIGCP_HOME = ${JSON.stringify(figcpHome)}
FIGCP_PORT = ${JSON.stringify(String(port))}`;

  let newContent: string;
  // Remove any existing [mcp_servers.figcp] or [mcp_servers.figcp.*] sections before appending cleanly
  const anyFigcpSection = /^\s*\[mcp_servers\.figcp(?:\.[^\]]+)?\][\s\S]*?(?=^\s*\[(?!mcp_servers\.figcp(?:\.|\]) )|$)/gm;
  const stripped = content.replace(anyFigcpSection, "").trimEnd();
  newContent = stripped.length > 0 ? `${stripped}\n\n${tomlBlock}\n` : `${tomlBlock}\n`;

  if (!dryRun) {
    const bakPath = `${filePath}.figcp.bak`;
    if (existsSync(filePath) && !existsSync(bakPath)) {
      copyFileSync(filePath, bakPath);
    }
    writeFileSync(filePath, newContent, "utf8");
  }
  return "updated";
}

export function runSetup(options: SetupOptions = {}): SetupResult {
  const userHome = options.homeDir ?? homedir();
  const figcpHome = options.figcpHome ?? resolveFigcpHome(join(userHome, ".figcp"));
  const port = options.port ?? Number(process.env.FIGCP_PORT ?? 1994);
  const dryRun = options.dryRun ?? false;
  const pluginDistDir = options.pluginDistDir ?? defaultPluginDistDir();
  const serverEntry = options.serverEntryPath ?? defaultServerEntryPath();

  const manifestSrc = join(pluginDistDir, "manifest.json");
  const codeSrc = join(pluginDistDir, "code.js");
  const uiSrc = join(pluginDistDir, "ui.template.html");

  if (!dryRun) {
    for (const required of [manifestSrc, codeSrc, uiSrc]) {
      if (!existsSync(required)) {
        throw new Error(
          `Missing built plugin artifact "${required}". Run "npm run build" before running --setup.`,
        );
      }
    }
  }

  const pluginDir = join(figcpHome, "plugin");
  const manifestPath = join(pluginDir, "manifest.json");
  const tokenPath = join(figcpHome, "token");

  const token = dryRun ? "00000000000000000000000000000000" : getOrCreateToken(figcpHome);

  if (!dryRun) {
    mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(pluginDir, 0o700);
    } catch {
      // Ignore on platforms that do not support POSIX chmod
    }

    const manifestObj = JSON.parse(readFileSync(manifestSrc, "utf8")) as {
      networkAccess?: { devAllowedDomains?: string[] };
    };
    if (manifestObj.networkAccess && Array.isArray(manifestObj.networkAccess.devAllowedDomains)) {
      manifestObj.networkAccess.devAllowedDomains = manifestObj.networkAccess.devAllowedDomains.map(
        (domain) => domain.replace(/:\d+$/, `:${port}`),
      );
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifestObj, null, 2)}\n`, "utf8");
    copyFileSync(codeSrc, join(pluginDir, "code.js"));

    const uiHtml = readFileSync(uiSrc, "utf8")
      .replaceAll("__FIGCP_PORT__", String(port))
      .replaceAll("__FIGCP_TOKEN__", token);
    const uiDest = join(pluginDir, "ui.html");
    writeFileSync(uiDest, uiHtml, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(uiDest, 0o600);
    } catch {
      // Ignore on platforms that do not support POSIX chmod
    }
  }

  const stdioEntry = {
    type: "stdio",
    command: process.execPath,
    args: [serverEntry],
    env: {
      FIGCP_HOME: figcpHome,
      FIGCP_PORT: String(port),
    },
  };

  const opencodeEntry = {
    type: "local",
    command: [process.execPath, serverEntry],
    environment: {
      FIGCP_HOME: figcpHome,
      FIGCP_PORT: String(port),
    },
  };

  const hasClaude =
    existsSync(join(userHome, ".claude.json")) || existsSync(join(userHome, ".claude"));

  const targets: Array<{
    name: string;
    path: string;
    sectionPath: readonly string[];
    value: unknown;
    legacyV1CleanupKey?: string;
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
      legacyV1CleanupKey: "figcp",
    },
  ];

  const updatedClients: string[] = [];
  const skippedClients: string[] = [];

  for (const target of targets) {
    const status = mergeJsonMcpConfig(
      target.path,
      target.sectionPath,
      "figcp",
      target.value,
      dryRun,
      target.legacyV1CleanupKey,
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
    const codexStatus = mergeTomlMcpConfig(
      codexPath,
      serverEntry,
      process.execPath,
      figcpHome,
      port,
      dryRun,
    );
    if (codexStatus === "updated") {
      updatedClients.push(`Codex CLI (${codexPath})`);
    } else {
      skippedClients.push("Codex CLI");
    }
  }

  const installedSkills: string[] = [];
  if (options.installSkill && !dryRun) {
    const here = dirname(fileURLToPath(import.meta.url));
    const skillCandidates = [
      resolve(here, "../../../skills/figcp/SKILL.md"),
      resolve(here, "../../skills/figcp/SKILL.md"),
      resolve(here, "../packages/skills/figcp/SKILL.md"),
    ];
    let skillSrc: string | undefined;
    for (const c of skillCandidates) {
      if (existsSync(c)) {
        skillSrc = c;
        break;
      }
    }

    if (skillSrc) {
      const skillDestinations = [
        join(userHome, ".gemini", "antigravity", "skills", "figcp"),
        join(userHome, ".agents", "skills", "figcp"),
      ];
      for (const destDir of skillDestinations) {
        const rootCandidate = dirname(dirname(destDir));
        if (existsSync(rootCandidate)) {
          mkdirSync(destDir, { recursive: true });
          const targetFile = join(destDir, "SKILL.md");
          copyFileSync(skillSrc, targetFile);
          installedSkills.push(targetFile);
        }
      }
    }
  }

  return {
    pluginDir,
    manifestPath,
    tokenPath,
    updatedClients,
    skippedClients,
    installedSkills,
    dryRun,
  };
}
