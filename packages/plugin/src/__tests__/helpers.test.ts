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
});
