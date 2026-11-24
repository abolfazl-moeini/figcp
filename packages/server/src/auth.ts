import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveFigcpHome(override?: string): string {
  return override || process.env.FIGCP_HOME || join(homedir(), ".figcp");
}

export function getOrCreateToken(homeDir?: string): string {
  const dir = resolveFigcpHome(homeDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Ignore on platforms that do not support POSIX chmod
  }
  const tokenPath = join(dir, "token");

  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(existing)) {
      try {
        chmodSync(tokenPath, 0o600);
      } catch {
        // Ignore on platforms that do not support POSIX chmod
      }
      return existing;
    }
  }

  const token = randomBytes(16).toString("hex");
  writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // Ignore on platforms that do not support POSIX chmod
  }
  return token;
}

export function validateAuthToken(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
