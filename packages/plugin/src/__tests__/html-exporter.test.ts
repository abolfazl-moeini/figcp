import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleExportToHtml } from "../html-exporter.ts";

describe("handleExportToHtml", () => {
  it("overrides Auto Layout FILL/HUG sizing cleanly (flex: 1 0 0 on main axis, 100% on cross axis)", async () => {
    const child1 = {
      id: "2:1",
      name: "FillMain",
      type: "FRAME",
      visible: true,
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "HUG",
      getCSSAsync: async () => ({ width: "200px", height: "40px" }),
      children: [],
    };
    const child2 = {
      id: "2:2",
      name: "HugMainFillCross",
      type: "FRAME",
      visible: true,
      layoutSizingHorizontal: "HUG",
      layoutSizingVertical: "FILL",
      getCSSAsync: async () => ({ width: "80px", height: "40px" }),
      children: [],
    };
    const root = {
      id: "1:1",
      name: "Root",
      type: "FRAME",
      visible: true,
      layoutMode: "HORIZONTAL",
      children: [child1, child2],
      getCSSAsync: async () => ({ display: "flex", width: "400px", height: "60px" }),
    };
    const figma = {
      currentPage: { selection: [root] },
      getNodeByIdAsync: async () => root,
      variables: { getVariableByIdAsync: async () => null },
    } as unknown as PluginAPI;

    const out = await handleExportToHtml(figma);
    assert.match(out.css, /flex: 1 0 0;/);
    assert.match(out.css, /min-width: 0;/);
    assert.match(out.css, /height: fit-content;/);
    assert.match(out.css, /width: fit-content;/);
    assert.match(out.css, /align-self: stretch;/);
    assert.match(out.css, /height: auto;/);
    assert.doesNotMatch(out.css, /width: 200px;/);
    assert.doesNotMatch(out.css, /height: 40px;/);
  });

  it("positions ABSOLUTE children and NONE-layout children relative to parent bounding box", async () => {
    const absBadge = {
      id: "2:1",
      name: "Badge",
      type: "FRAME",
      visible: true,
      layoutPositioning: "ABSOLUTE",
      absoluteBoundingBox: { x: 120, y: 210, width: 16, height: 16 },
      children: [],
      getCSSAsync: async () => ({}),
    };
    const autoParent = {
      id: "1:1",
      name: "Root",
      type: "FRAME",
      visible: true,
      layoutMode: "HORIZONTAL",
      absoluteBoundingBox: { x: 100, y: 200, width: 300, height: 80 },
      children: [absBadge],
      getCSSAsync: async () => ({}),
    };
    const freeChild = {
      id: "4:1",
      name: "FreeBox",
      type: "RECTANGLE",
      visible: true,
      absoluteBoundingBox: { x: 45, y: 55, width: 50, height: 20 },
      getCSSAsync: async () => ({}),
    };
    const freeParent = {
      id: "3:1",
      name: "FreeFrame",
      type: "FRAME",
      visible: true,
      layoutMode: "NONE",
      absoluteBoundingBox: { x: 10, y: 20, width: 200, height: 100 },
      children: [freeChild],
      getCSSAsync: async () => ({}),
    };

    const figma = {
      currentPage: { selection: [autoParent] },
      getNodeByIdAsync: async () => autoParent,
      variables: { getVariableByIdAsync: async () => null },
    } as unknown as PluginAPI;

    const autoOut = await handleExportToHtml(figma);
    assert.match(autoOut.css, /position: relative;/);
    assert.match(autoOut.css, /position: absolute;/);
    assert.match(autoOut.css, /left: 20px;/);
    assert.match(autoOut.css, /top: 10px;/);

    (figma.currentPage as unknown as { selection: unknown[] }).selection = [freeParent];
    const freeOut = await handleExportToHtml(figma);
    assert.match(freeOut.css, /position: relative;/);
    assert.match(freeOut.css, /left: 35px;/);
    assert.match(freeOut.css, /top: 35px;/);
  });

  it("resolves semantic VARIABLE_ALIAS chains, emits :root block, binds TEXT color vs FRAME background, and caches lookups", async () => {
    const calls: string[] = [];
    const vars: Record<string, unknown> = {
      var_white: {
        id: "var_white",
        name: "primitive/white",
        resolvedType: "COLOR",
        valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } },
      },
      var_card: {
        id: "var_card",
        name: "surface/card",
        resolvedType: "COLOR",
        valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "var_white" } },
      },
      var_text: {
        id: "var_text",
        name: "text/primary",
        resolvedType: "COLOR",
        valuesByMode: { m1: { r: 0, g: 0, b: 0, a: 1 } },
      },
      var_gap: {
        id: "var_gap",
        name: "space/md",
        resolvedType: "FLOAT",
        valuesByMode: { m1: 16 },
      },
    };

    const card1 = {
      id: "2:1",
      name: "Card1",
      type: "FRAME",
      visible: true,
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, visible: true }],
      boundVariables: {
        fills: [{ type: "VARIABLE_ALIAS", id: "var_card" }],
        itemSpacing: { type: "VARIABLE_ALIAS", id: "var_gap" },
      },
      children: [],
      getCSSAsync: async () => ({ background: "#FFFFFF" }),
    };
    const card2 = {
      id: "2:2",
      name: "Card2",
      type: "FRAME",
      visible: true,
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, visible: true }],
      boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "var_card" }] },
      children: [],
      getCSSAsync: async () => ({}),
    };
    const label = {
      id: "2:3",
      name: "Title",
      type: "TEXT",
      visible: true,
      characters: "Hello",
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, visible: true }],
      boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "var_text" }] },
      getCSSAsync: async () => ({ color: "#000" }),
    };
    const root = {
      id: "1:1",
      name: "Root",
      type: "FRAME",
      visible: true,
      layoutMode: "VERTICAL",
      children: [card1, card2, label],
      getCSSAsync: async () => ({}),
    };
    const figma = {
      currentPage: { selection: [root] },
      getNodeByIdAsync: async () => root,
      variables: {
        getVariableByIdAsync: async (id: string) => {
          calls.push(id);
          return vars[id] ?? null;
        },
      },
    } as unknown as PluginAPI;

    const out = await handleExportToHtml(figma);
    assert.equal(out.cssVariables["--surface-card"], "#ffffff");
    assert.equal(out.cssVariables["--text-primary"], "#000000");
    assert.equal(out.cssVariables["--space-md"], "16px");
    assert.match(out.css, /:root \{[\s\S]*--surface-card: #ffffff;/);
    assert.match(out.css, /background-color: var\(--surface-card, #ffffff\);/);
    assert.match(out.css, /color: var\(--text-primary, #000000\);/);
    assert.match(out.css, /gap: var\(--space-md, 16px\);/);
    assert.doesNotMatch(out.css, /background: #FFFFFF;/);
    // var_card was bound twice across card1 & card2, but fetched only once
    assert.equal(calls.filter((c) => c === "var_card").length, 1);
  });

  it("embeds inline SVG inside flex-safe <span> without recursing and handles IMAGE fills", async () => {
    const icon = {
      id: "3:1",
      name: "Icon",
      type: "FRAME",
      visible: true,
      width: 16,
      height: 16,
      isAsset: true,
      children: [{ id: "3:2", name: "vec", type: "VECTOR", visible: true }],
      exportAsync: async () => '<?xml version="1.0"?><svg viewBox="0 0 16 16"><path d="M0 0"/></svg>',
      getCSSAsync: async () => ({ width: "16px", height: "16px" }),
    };
    const figma = {
      currentPage: { selection: [icon] },
      getNodeByIdAsync: async () => icon,
      variables: { getVariableByIdAsync: async () => null },
    } as unknown as PluginAPI;

    const svgOut = await handleExportToHtml(figma);
    assert.equal(svgOut.stats.svgCount, 1);
    assert.equal(svgOut.stats.nodeCount, 1);
    assert.match(svgOut.html, /<span class="fg-icon-1"[^>]*><svg viewBox="0 0 16 16">/);
    assert.doesNotMatch(svgOut.html, /<\?xml/);
    assert.match(svgOut.css, /display: inline-flex;/);
    assert.match(svgOut.css, /flex-shrink: 0;/);

    const image = {
      id: "4:1",
      name: "Photo",
      type: "RECTANGLE",
      visible: true,
      fills: [{ type: "IMAGE", visible: true, imageHash: "abc" }],
      exportAsync: async () => new Uint8Array([137, 80, 78, 71]),
      getCSSAsync: async () => ({ width: "100px", height: "100px" }),
    };
    (figma.currentPage as unknown as { selection: unknown[] }).selection = [image];
    const placeholder = await handleExportToHtml(figma);
    assert.equal(placeholder.stats.imageCount, 1);
    assert.ok(placeholder.warnings.length > 0);
    assert.doesNotMatch(placeholder.css, /data:image\/png;base64/);

    const embedded = await handleExportToHtml(figma, { inlineImages: true });
    assert.equal(embedded.stats.imageCount, 1);
    assert.match(embedded.css, /data:image\/png;base64,iVBORw==/);
  });

  it("renders Persian RTL text, escapes HTML, maps styled segment weights/styles/decorations, and supports fragment mode", async () => {
    const text = {
      id: "2:1",
      name: "سلام",
      type: "TEXT",
      visible: true,
      characters: 'سلام <script>&"test"\nخط دوم',
      getStyledTextSegments: () => [
        {
          characters: "سلام ",
          fontName: { family: "IRANSansXFaNum", style: "SemiBold" },
          fontSize: 16,
          fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.2, b: 0.3 } }],
          textDecoration: "UNDERLINE",
        },
        {
          characters: '<script>&"test"\nخط دوم',
          fontName: { family: "IRANSansXFaNum", style: "Regular Italic" },
          fontSize: 14,
          fills: [],
          textDecoration: "NONE",
        },
      ],
      getCSSAsync: async () => ({}),
    };
    const figma = {
      currentPage: { selection: [text] },
      getNodeByIdAsync: async () => text,
      variables: { getVariableByIdAsync: async () => null },
    } as unknown as PluginAPI;

    const standalone = await handleExportToHtml(figma);
    assert.ok(standalone.html.startsWith("<!DOCTYPE html>"));
    assert.ok(standalone.html.includes('<html lang="fa">'));
    assert.ok(standalone.html.includes("body, p { margin: 0; }"));
    assert.ok(standalone.html.includes('dir="rtl"'));
    assert.ok(standalone.html.includes("&lt;script&gt;&amp;&quot;test&quot;<br />"));
    assert.ok(!standalone.html.includes("<script>"));
    assert.match(standalone.html, /font-weight: 600/);
    assert.match(standalone.html, /font-style: italic/);
    assert.match(standalone.html, /text-decoration: underline/);
    assert.match(standalone.css, /margin: 0;/);

    const fragment = await handleExportToHtml(figma, { mode: "fragment" });
    assert.ok(!fragment.html.includes("<!DOCTYPE html>"));
    assert.ok(fragment.html.startsWith("<p "));
  });

  it("skips invisible nodes and emits maxNodes truncation warning even when prior warnings exist", async () => {
    const imgChild = {
      id: "2:1",
      name: "Img",
      type: "RECTANGLE",
      visible: true,
      fills: [{ type: "IMAGE", visible: true, imageHash: "abc" }],
      getCSSAsync: async () => ({}),
    };
    const hidden = { id: "2:2", name: "HiddenLayer", type: "FRAME", visible: false, children: [] };
    const extra = { id: "2:3", name: "OverflowNode", type: "RECTANGLE", visible: true, getCSSAsync: async () => ({}) };
    const root = {
      id: "1:1",
      name: "Root",
      type: "FRAME",
      visible: true,
      children: [imgChild, hidden, extra],
      getCSSAsync: async () => ({}),
    };
    const figma = {
      currentPage: { selection: [root] },
      getNodeByIdAsync: async () => root,
      variables: { getVariableByIdAsync: async () => null },
    } as unknown as PluginAPI;

    const out = await handleExportToHtml(figma, { maxNodes: 2 });
    assert.ok(!out.html.includes("HiddenLayer"));
    assert.equal(out.stats.truncated, true);
    assert.ok(out.warnings.some((w) => w.includes("Image fill")));
    assert.ok(out.warnings.some((w) => w.includes("maxNodes")));
  });

  it("sets position: relative on GROUP/undefined-layout parents, disambiguates colliding non-ASCII var names, and preserves mixed vector+text frames", async () => {
    const groupChild = {
      id: "2:1",
      name: "GroupItem",
      type: "RECTANGLE",
      visible: true,
      absoluteBoundingBox: { x: 25, y: 35, width: 40, height: 20 },
      getCSSAsync: async () => ({}),
    };
    const groupParent = {
      id: "1:1",
      name: "IconGroup",
      type: "GROUP",
      visible: true,
      absoluteBoundingBox: { x: 10, y: 15, width: 100, height: 60 },
      children: [groupChild],
      getCSSAsync: async () => ({}),
    };
    const mixedIconAndLabel = {
      id: "1:2",
      name: "ButtonWithIcon",
      type: "FRAME",
      visible: true,
      layoutMode: "HORIZONTAL",
      children: [
        {
          id: "2:2",
          name: "PureVectorIcon",
          type: "FRAME",
          visible: true,
          width: 12,
          height: 12,
          children: [{ id: "3:1", name: "Path", type: "VECTOR", visible: true }],
          exportAsync: async () => "<svg viewBox=\"0 0 12 12\"></svg>",
          getCSSAsync: async () => ({}),
        },
        {
          id: "2:3",
          name: "Label",
          type: "TEXT",
          visible: true,
          characters: "تایید",
          getCSSAsync: async () => ({}),
        },
      ],
      getCSSAsync: async () => ({ display: "flex" }),
    };

    const vars: Record<string, unknown> = {
      v1: { id: "v1", name: "رنگ/اول", resolvedType: "COLOR", valuesByMode: { m1: { r: 1, g: 0, b: 0 } } },
      v2: { id: "v2", name: "رنگ/دوم", resolvedType: "COLOR", valuesByMode: { m1: { r: 0, g: 1, b: 0 } } },
    };
    const box1 = {
      id: "4:1",
      name: "Box1",
      type: "FRAME",
      visible: true,
      boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "v1" }] },
      children: [],
      getCSSAsync: async () => ({}),
    };
    const box2 = {
      id: "4:2",
      name: "Box2",
      type: "FRAME",
      visible: true,
      boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "v2" }] },
      children: [],
      getCSSAsync: async () => ({}),
    };

    const root = {
      id: "0:1",
      name: "Container",
      type: "FRAME",
      visible: true,
      layoutMode: "VERTICAL",
      children: [groupParent, mixedIconAndLabel, box1, box2],
      getCSSAsync: async () => ({ display: "flex" }),
    };

    const figma = {
      currentPage: { selection: [root] },
      getNodeByIdAsync: async () => root,
      variables: { getVariableByIdAsync: async (id: string) => vars[id] ?? null },
    } as unknown as PluginAPI;

    const out = await handleExportToHtml(figma);
    // GROUP gets position: relative and its child gets left: 15px, top: 20px
    assert.match(out.css, /\.fg-icongroup-2 \{[^\}]*position: relative;/);
    assert.match(out.css, /\.fg-groupitem-3 \{[^\}]*position: absolute;[^\}]*left: 15px; top: 20px;/);
    // PureVectorIcon (nested vector frame without isAsset) becomes SVG, while mixedIconAndLabel stays container + TEXT
    assert.equal(out.stats.svgCount, 1);
    assert.ok(out.html.includes("تایید"));
    // Non-ASCII colliding variable names disambiguate cleanly
    assert.equal(out.cssVariables["--token"], "#ff0000");
    assert.equal(out.cssVariables["--token-2"], "#00ff00");
    assert.match(out.css, /var\(--token-2, #00ff00\)/);
  });
});
