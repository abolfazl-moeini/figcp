import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { detectUiLevel, getUiLevelConfig, setUiLevelConfig } from "../cli/ui-level-addon.ts";
import { loadCodeConnectMap, matchCodeConnect } from "../code-connect.ts";

describe("Code Connect & ui-level Addon", () => {
  it("loads figcp.map.json and matches component names accurately", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "figcp-cc-"));
    try {
      const mapData = {
        "Button/Primary": { file: "src/components/Button.tsx", export: "Button" },
        "SearchBox": { file: "src/components/SearchBox.tsx", export: "SearchBox" },
      };
      writeFileSync(join(tempDir, "figcp.map.json"), JSON.stringify(mapData), "utf8");

      const loaded = loadCodeConnectMap(tempDir);
      assert.ok(loaded);

      // Exact match
      const m1 = matchCodeConnect(loaded, "Button/Primary");
      assert.equal(m1?.file, "src/components/Button.tsx");

      // Suffix match (e.g. nested in Figma as "Elements/Button/Primary")
      const m2 = matchCodeConnect(loaded, "Elements/Button/Primary");
      assert.equal(m2?.file, "src/components/Button.tsx");

      // Case-insensitive match
      const m3 = matchCodeConnect(loaded, "searchbox");
      assert.equal(m3?.file, "src/components/SearchBox.tsx");

      // No match
      const m4 = matchCodeConnect(loaded, "UnknownComponent");
      assert.equal(m4, undefined);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("manages ui-level config persistence and non-intrusive detection", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "figcp-uicfg-"));
    try {
      const initial = getUiLevelConfig(tempHome);
      assert.equal(initial.uiLevel, "disabled");

      setUiLevelConfig("enabled", tempHome);
      const updated = getUiLevelConfig(tempHome);
      assert.equal(updated.uiLevel, "enabled");

      setUiLevelConfig("declined", tempHome);
      const declined = getUiLevelConfig(tempHome);
      assert.equal(declined.uiLevel, "declined");

      // detectUiLevel returns boolean without crashing
      const detected = detectUiLevel();
      assert.equal(typeof detected, "boolean");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
