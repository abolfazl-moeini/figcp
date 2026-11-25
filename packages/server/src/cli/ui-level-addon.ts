import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolveFigcpHome } from "../auth.ts";

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

export function enableUiLevelAddon(
  figcpHome = resolveFigcpHome(),
  options: { installPackage?: boolean } = {},
): {
  ok: boolean;
  installed: boolean;
  message: string;
} {
  let installed = detectUiLevel();

  if (!installed && options.installPackage) {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const installRes = spawnSync(npmCmd, ["install", "-g", "ui-level"], {
      stdio: "inherit",
    });
    if (installRes.status === 0) {
      installed = detectUiLevel();
    } else {
      setUiLevelConfig("enabled", figcpHome);
      return {
        ok: false,
        installed: false,
        message: "Failed to install `ui-level` globally via npm. Enabled in config; install manually with `npm install -g ui-level`.",
      };
    }
  }

  setUiLevelConfig("enabled", figcpHome);

  if (installed) {
    return {
      ok: true,
      installed: true,
      message: "ui-level integration enabled. Offline NormalizedSpec exports will verify against ui-level.",
    };
  }

  return {
    ok: true,
    installed: false,
    message:
      "ui-level enabled in config. Note: ui-level binary not detected on PATH. Install it via `npm install -g ui-level` when ready.",
  };
}
