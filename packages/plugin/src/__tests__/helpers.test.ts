import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPluginHelpers, hexToRgb, hexToRgba } from "../helpers.ts";

describe("plugin helpers", () => {
  it("converts hex and hex+alpha colors accurately", () => {
    const rgb = hexToRgb("#3B82F6");
    assert.ok(Math.abs(rgb.r - 59 / 255) < 1e-6);
    assert.ok(Math.abs(rgb.g - 130 / 255) < 1e-6);
    assert.ok(Math.abs(rgb.b - 246 / 255) < 1e-6);

    const rgba = hexToRgba("#3B82F680");
    assert.ok(Math.abs(rgba.a - 128 / 255) < 1e-6);

    assert.throws(() => hexToRgb("#12345678"), /Invalid hex color/);
    assert.throws(() => hexToRgba("#12345"), /Invalid hex color/);
  });

  it("loads font BEFORE setting text characters in setTextSafe", async () => {
    const order: string[] = [];
    const helpers = createPluginHelpers({
      loadFontAsync: async () => {
        order.push("loadFontAsync");
      },
      listAvailableFontsAsync: async () => [],
      variables: {
        getLocalVariableCollectionsAsync: async () => [],
        getLocalVariablesAsync: async () => [],
        setBoundVariableForPaint: (p) => p,
      },
      currentPage: { selection: [] },
      viewport: { scrollAndZoomIntoView: () => {} },
    });

    const textNode = {
      fontName: { family: "Inter", style: "Regular" },
      _chars: "",
      get characters() {
        return this._chars;
      },
      set characters(v: string) {
        order.push("setCharacters");
        this._chars = v;
      },
    };

    await helpers.setTextSafe(textNode, "سلام", { family: "IRANSansXFaNum", style: "Regular" });
    assert.deepEqual(order, ["loadFontAsync", "setCharacters"]);
    assert.equal(textNode.characters, "سلام");
  });

  it("calls resize BEFORE applying Auto Layout sizing modes", () => {
    const order: string[] = [];
    const helpers = createPluginHelpers({
      loadFontAsync: async () => {},
      listAvailableFontsAsync: async () => [],
      variables: {
        getLocalVariableCollectionsAsync: async () => [],
        getLocalVariablesAsync: async () => [],
        setBoundVariableForPaint: (p) => p,
      },
      currentPage: { selection: [] },
      viewport: { scrollAndZoomIntoView: () => {} },
    });

    const frame = {
      _p: "FIXED" as "FIXED" | "AUTO",
      _c: "FIXED" as "FIXED" | "AUTO",
      resize: () => {
        order.push("resize");
        frame._p = "FIXED";
        frame._c = "FIXED";
      },
      get primaryAxisSizingMode() {
        return this._p;
      },
      set primaryAxisSizingMode(v: "FIXED" | "AUTO") {
        order.push(`primary:${v}`);
        this._p = v;
      },
      get counterAxisSizingMode() {
        return this._c;
      },
      set counterAxisSizingMode(v: "FIXED" | "AUTO") {
        order.push(`counter:${v}`);
        this._c = v;
      },
    };

    helpers.resizeFrameSafe(frame, 340, 44, { primary: "AUTO", counter: "FIXED" });
    assert.deepEqual(order, ["resize", "primary:AUTO", "counter:FIXED"]);
    assert.equal(frame.primaryAxisSizingMode, "AUTO");
  });

  it("returns font suggestions when loadFontSafe fails", async () => {
    const helpers = createPluginHelpers({
      loadFontAsync: async () => {
        throw new Error("Font not found");
      },
      listAvailableFontsAsync: async () => [
        { fontName: { family: "IRANSansXFaNum", style: "Medium" } },
        { fontName: { family: "Inter", style: "Regular" } },
      ],
      variables: {
        getLocalVariableCollectionsAsync: async () => [],
        getLocalVariablesAsync: async () => [],
        setBoundVariableForPaint: (p) => p,
      },
      currentPage: { selection: [] },
      viewport: { scrollAndZoomIntoView: () => {} },
    });

    const res = await helpers.loadFontSafe({ family: "IRANSansXFaNum", style: "Regular" });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.suggestions.length, 1);
      assert.equal(res.suggestions[0]?.family, "IRANSansXFaNum");
    }
  });

  it("guards resizeFrameSafe on layoutMode NONE without setting sizing modes", () => {
    const order: string[] = [];
    const helpers = createPluginHelpers({
      loadFontAsync: async () => {},
      listAvailableFontsAsync: async () => [],
      variables: {
        getLocalVariableCollectionsAsync: async () => [],
        getLocalVariablesAsync: async () => [],
        setBoundVariableForPaint: (p) => p,
      },
      currentPage: { selection: [] },
      viewport: { scrollAndZoomIntoView: () => {} },
    });

    const frame = {
      layoutMode: "NONE" as const,
      resize: (w: number, h: number) => {
        order.push(`resize:${w}x${h}`);
      },
      set primaryAxisSizingMode(_: any) {
        order.push("trap:primary");
      },
      set counterAxisSizingMode(_: any) {
        order.push("trap:counter");
      },
    };

    helpers.resizeFrameSafe(frame, 200, 100, { primary: "AUTO", counter: "FIXED" });
    assert.deepEqual(order, ["resize:200x100"]);
  });

  it("enforces strict requireFont preflight", async () => {
    const helpers = createPluginHelpers({
      loadFontAsync: async () => {},
      listAvailableFontsAsync: async () => [
        { fontName: { family: "IRANSansXFaNum", style: "Regular" } },
        { fontName: { family: "IRANSansXFaNum", style: "Bold" } },
      ],
      variables: {
        getLocalVariableCollectionsAsync: async () => [],
        getLocalVariablesAsync: async () => [],
        setBoundVariableForPaint: (p) => p,
      },
      currentPage: { selection: [] },
      viewport: { scrollAndZoomIntoView: () => {} },
    });

    // Exact match succeeds
    await helpers.requireFont({ family: "IRANSansXFaNum", style: "Bold" });

    // Missing family throws
    await assert.rejects(
      helpers.requireFont({ family: "NonExistentFont", style: "Regular" }),
      /Font family "NonExistentFont" is not installed/,
    );

    // Missing style throws with list of available styles
    await assert.rejects(
      helpers.requireFont({ family: "IRANSansXFaNum", style: "Black" }),
      /Font style "Black" not found.*Available installed styles: "Regular", "Bold"/,
    );
  });

  it("binds Variable objects (not string IDs), creates variables, and applies text styles", async () => {
    const varObj = { id: "v_1", name: "gap/sm", variableCollectionId: "c_1", setValueForMode: () => {} };
    const boundCalls: Array<{ field: string; variable: unknown }> = [];
    let appliedStyleId = "";

    const helpers = createPluginHelpers({
      loadFontAsync: async () => {},
      listAvailableFontsAsync: async () => [],
      getLocalTextStylesAsync: async () => [{ id: "ts_1", name: "Body/Regular" }],
      variables: {
        getLocalVariableCollectionsAsync: async () => [{ id: "c_1", name: "Tokens" }],
        getLocalVariablesAsync: async () => [varObj],
        getVariableByIdAsync: async (id: string) => (id === "v_1" ? (varObj as unknown as Variable) : null),
        createVariableCollection: (name: string) => ({ id: "c_new", name, modes: [{ modeId: "m1", name: "Mode 1" }] }),
        createVariable: (name: string) => ({ id: "v_new", name, setValueForMode: () => {} }) as unknown as Variable,
        setBoundVariableForPaint: (p) => p,
      },
      currentPage: { selection: [] },
      viewport: { scrollAndZoomIntoView: () => {} },
    });

    const node = {
      setBoundVariable: (field: string, variable: Variable | null) => {
        boundCalls.push({ field, variable });
      },
    };

    await helpers.bindVariable(node, "itemSpacing", varObj as unknown as Variable);
    await helpers.bindVariable(node, "paddingTop", "v_1");
    assert.equal(boundCalls[0]?.variable, varObj);
    assert.equal(boundCalls[1]?.variable, varObj);

    const existingVar = await helpers.getOrCreateVariable("Tokens", "gap/sm", "FLOAT", 8);
    assert.equal((existingVar as unknown as { id: string }).id, "v_1");

    const newVar = await helpers.getOrCreateVariable("NewCol", "brand/accent", "COLOR", "#ff0000");
    assert.equal((newVar as unknown as { id: string }).id, "v_new");

    const textNode = {
      setTextStyleIdAsync: async (id: string) => {
        appliedStyleId = id;
      },
    };
    const ok = await helpers.setTextStyleSafe(textNode, "Regular");
    assert.equal(ok, true);
    assert.equal(appliedStyleId, "ts_1");
  });
});
