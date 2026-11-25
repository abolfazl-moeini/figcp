import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveFigcpHome } from "../auth.ts";

export type UiLevelState = "disabled" | "enabled" | "declined";

export interface FigcpConfig {
  uiLevel?: UiLevelState;
}

export function detectUiLevel(): boolean {
  try {
    execSync("which ui-level", { stdio: "ignore" });
    return true;
  } catch {
    // Check local developer path or repo node_modules
    const localDevPath = "/Users/moeini/Dev/ui-level";
    if (existsSync(localDevPath)) return true;
    const binPath = join(process.cwd(), "node_modules", ".bin", "ui-level");
    if (existsSync(binPath)) return true;
    return false;
  }
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
  const cfgPath = join(figcpHome, "config.json");
  const existing = getUiLevelConfig(figcpHome);
  existing.uiLevel = state;
  writeFileSync(cfgPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

export function enableUiLevelAddon(figcpHome = resolveFigcpHome()): {
  ok: boolean;
  message: string;
} {
  const installed = detectUiLevel();
  setUiLevelConfig("enabled", figcpHome);

  if (installed) {
    return {
      ok: true,
      message: "ui-level integration enabled. Offline NormalizedSpec exports will verify against ui-level.",
    };
  }

  return {
    ok: true,
    message:
      "ui-level enabled in config. Note: ui-level binary not detected on PATH. Install it via `npm install -g ui-level` or link /Users/moeini/Dev/ui-level.",
  };
}
