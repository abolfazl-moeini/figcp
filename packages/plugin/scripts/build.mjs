import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const distDir = join(pkgRoot, "dist");

mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: [join(pkgRoot, "src/code.ts")],
  outfile: join(distDir, "code.js"),
  bundle: true,
  platform: "browser",
  target: "es2017",
  format: "iife",
  sourcemap: false,
});

copyFileSync(join(pkgRoot, "manifest.json"), join(distDir, "manifest.json"));
copyFileSync(join(pkgRoot, "src/ui.template.html"), join(distDir, "ui.template.html"));
copyFileSync(join(pkgRoot, "src/ui.template.html"), join(distDir, "ui.html"));
console.error("[figcp:plugin] Built dist/code.js, manifest.json, ui.template.html, and ui.html");
