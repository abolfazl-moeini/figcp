import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const distDir = join(pkgRoot, "dist");

mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: [join(pkgRoot, "src/index.ts")],
  outfile: join(distDir, "index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: false,
});

console.error("[figcp:server] Built dist/index.js");
