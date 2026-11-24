import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(import.meta.url), "../..");
const testFiles = [];

function collectTests(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTests(full);
    } else if (entry.endsWith(".test.ts")) {
      testFiles.push(full);
    }
  }
}

const packagesDir = join(rootDir, "packages");
if (existsSync(packagesDir)) {
  for (const pkg of readdirSync(packagesDir).sort()) {
    collectTests(join(packagesDir, pkg, "src", "__tests__"));
  }
}
collectTests(join(rootDir, "tests", "e2e"));

if (testFiles.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: rootDir,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
