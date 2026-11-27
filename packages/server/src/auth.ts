import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveFigcpHome(override?: string, fallbackHomeDir?: string): string {
  const envHome = process.env.FIGCP_HOME?.trim();
  const raw = override?.trim() || envHome || join(fallbackHomeDir ?? homedir(), ".figcp");
  return resolve(raw);
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

  const readValidToken = (): string | null => {
    if (!existsSync(tokenPath)) return null;
    try {
      const existing = readFileSync(tokenPath, "utf8").trim();
      if (/^[0-9a-f]{32}$/.test(existing)) {
        try {
          chmodSync(tokenPath, 0o600);
        } catch {
          // Ignore on platforms that do not support POSIX chmod
        }
        return existing;
      }
    } catch {
      // Ignore read races
    }
    return null;
  };

  const valid = readValidToken();
  if (valid) return valid;

  const token = randomBytes(16).toString("hex");
  try {
    writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      chmodSync(tokenPath, 0o600);
    } catch {
      // Ignore on platforms that do not support POSIX chmod
    }
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const winner = readValidToken();
      if (winner) return winner;
      // Existing file was invalid; atomically replace via temp file
      const tmpPath = `${tokenPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
      writeFileSync(tmpPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmpPath, tokenPath);
      return token;
    }
    throw err;
  }
}

export function validateAuthToken(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
