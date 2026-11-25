import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFigcpHome } from "../auth.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  details?: unknown;
}

export interface DoctorReport {
  overallOk: boolean;
  checks: DoctorCheck[];
}

export async function runDoctor(options: {
  homeDir?: string;
  figcpHome?: string;
  port?: number;
} = {}): Promise<DoctorReport> {
  const userHome = options.homeDir ?? homedir();
  const figcpHome = options.figcpHome ?? resolveFigcpHome(join(userHome, ".figcp"));
  const port = options.port ?? Number(process.env.FIGCP_PORT ?? 1994);
  const checks: DoctorCheck[] = [];

  // 1. Node version check
  const nodeVer = process.versions.node;
  const major = parseInt(nodeVer.split(".")[0] ?? "0", 10);
  const nodeOk = major >= 22;
  checks.push({
    name: "Node.js Runtime",
    ok: nodeOk,
    message: nodeOk
      ? `Node v${nodeVer} (>= 22 required)`
      : `Node v${nodeVer} is unsupported. Please upgrade to Node.js >= 22.`,
  });

  // 2. Loopback Auth Token
  const tokenPath = join(figcpHome, "token");
  if (existsSync(tokenPath)) {
    const raw = readFileSync(tokenPath, "utf8").trim();
    const tokenValid = /^[0-9a-f]{32}$/.test(raw);
    const mode = process.platform !== "win32" ? statSync(tokenPath).mode & 0o777 : 0o600;
    const modeOk = process.platform === "win32" || mode === 0o600;
    checks.push({
      name: "Loopback Token",
      ok: tokenValid && modeOk,
      message:
        tokenValid && modeOk
          ? `Valid 32-char hex token (${tokenPath})`
          : `Token invalid or unsafe permissions (mode: 0${mode.toString(8)})`,
    });
  } else {
    checks.push({
      name: "Loopback Token",
      ok: false,
      message: `Token file missing at "${tokenPath}". Run "figcp --setup".`,
    });
  }

  // 3. Installed Figma Plugin
  const pluginManifest = join(figcpHome, "plugin", "manifest.json");
  const pluginCode = join(figcpHome, "plugin", "code.js");
  const pluginUi = join(figcpHome, "plugin", "ui.html");
  const pluginInstalled =
    existsSync(pluginManifest) && existsSync(pluginCode) && existsSync(pluginUi);
  checks.push({
    name: "Installed Figma Plugin",
    ok: pluginInstalled,
    message: pluginInstalled
      ? `Plugin files present in ${join(figcpHome, "plugin")}`
      : `Plugin missing in "${join(figcpHome, "plugin")}". Run "figcp --setup".`,
  });

  // 4. Client MCP Configurations
  const clients = [
    { name: "Cursor", path: join(userHome, ".cursor", "mcp.json") },
    { name: "Antigravity", path: join(userHome, ".gemini", "antigravity", "mcp_config.json") },
    { name: "Claude Code", path: join(userHome, ".claude.json") },
    { name: "Codex CLI", path: join(userHome, ".codex", "config.toml") },
    { name: "OpenCode", path: join(userHome, ".config", "opencode", "opencode.json") },
  ];
  const configuredClients: string[] = [];
  for (const client of clients) {
    if (existsSync(client.path)) {
      try {
        const text = readFileSync(client.path, "utf8");
        if (text.includes("figcp")) {
          configuredClients.push(client.name);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
  checks.push({
    name: "MCP Client Integrations",
    ok: configuredClients.length > 0,
    message:
      configuredClients.length > 0
        ? `Configured in: ${configuredClients.join(", ")}`
        : 'No MCP client configurations detected with "figcp". Run "figcp --setup".',
  });

  // 5. Port & Bridge Reachability
  const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      const pingData = (await res.json().catch(() => ({}))) as { service?: string; role?: string };
      if (pingData.service === "figcp") {
        checks.push({
          name: "Bridge Health",
          ok: true,
          message: `Active ${pingData.role ?? "leader"} running on 127.0.0.1:${port}.`,
        });
      } else {
        checks.push({
          name: "Bridge Health",
          ok: false,
          message: `Port 127.0.0.1:${port} is occupied by another service.`,
        });
      }
    } else {
      checks.push({
        name: "Bridge Health",
        ok: false,
        message: `HTTP /ping returned status ${res.status}. Check token or port.`,
      });
    }
  } catch {
    // Port is free or bridge not running
    checks.push({
      name: "Bridge Health",
      ok: true,
      message: `Port 127.0.0.1:${port} is available (bridge will auto-start on demand).`,
    });
  }

  const overallOk = checks.every((c) => c.ok);
  return { overallOk, checks };
}
