import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toDtcgTokens } from "../dtcg-export.ts";
import type { DesignSystemSnapshot } from "../protocol.ts";
import { toUiLevelNormalizedSpec, type DesignContextNode } from "../ui-level-export.ts";

describe("DTCG & ui-level Cross-Contract Exporters", () => {
  it("converts DesignSystemSnapshot to standard W3C DTCG tokens", () => {
    const mockSnapshot: DesignSystemSnapshot = {
      fileName: "Test DS",
      currentPage: "Tokens",
      variableCollections: [
        {
          id: "col1",
          name: "Colors",
          modes: [{ modeId: "m1", name: "Default" }],
          variables: [
            {
              id: "v1",
              name: "brand/primary",
              resolvedType: "COLOR",
              valuesByMode: { m1: "#3b82f6" },
            },
            {
              id: "v2",
              name: "spacing/md",
              resolvedType: "FLOAT",
              valuesByMode: { m1: 16 },
            },
            {
              id: "v3",
              name: "border/focus",
              resolvedType: "COLOR",
              valuesByMode: { m1: '{brand/primary} = "#3b82f6"' },
            },
          ],
        },
      ],
      styles: {
        paint: [{ id: "p1", name: "surface/card", hex: "#ffffff" }],
        text: [
          {
            id: "t1",
            name: "heading/h1",
            fontName: { family: "IRANSansXFaNum", style: "Bold" },
            fontSize: 24,
          },
        ],
        effect: [],
      },
      componentSets: [],
    };

    const tokens = toDtcgTokens(mockSnapshot);
    const colors = tokens["Colors"] as Record<string, any>;
    assert.ok(colors);
    assert.deepEqual(colors["brand"]?.["primary"], { $type: "color", $value: "#3b82f6" });
    assert.deepEqual(colors["spacing"]?.["md"], { $type: "dimension", $value: "16px" });
    assert.deepEqual(colors["border"]?.["focus"], { $type: "color", $value: "{brand.primary}" });

    const paintGroup = tokens["colorStyles"] as Record<string, any>;
    assert.deepEqual(paintGroup?.["surface.card"], { $type: "color", $value: "#ffffff" });

    const textGroup = tokens["textStyles"] as Record<string, any>;
    assert.deepEqual(textGroup?.["heading.h1"], {
      $type: "typography",
      $value: {
        fontFamily: "IRANSansXFaNum",
        fontWeight: "Bold",
        fontSize: "24px",
      },
    });
  });

  it("converts DesignContextNode into offline NormalizedSpec for ui-level", () => {
    const root: DesignContextNode = {
      id: "10:1",
      name: "Search Card",
      type: "FRAME",
      rect: { x: 50, y: 100, width: 360, height: 120 },
      layoutMode: "HORIZONTAL",
      itemSpacing: 12,
      padding: { top: 16, right: 20, bottom: 16, left: 20 },
      cornerRadius: 12,
      fills: [{ hex: "#ffffff" }],
      strokes: [{ hex: "#e2e8f0", width: 1 }],
      children: [
        {
          id: "10:2",
          name: "Search Input",
          type: "TEXT",
          rect: { x: 70, y: 116, width: 280, height: 32 },
          typography: {
            characters: "جستجو در سامانه...",
            fontFamily: "IRANSansXFaNum",
            fontWeight: "Regular",
            fontSize: 14,
            textAlign: "RIGHT",
          },
          fills: [{ hex: "#1e293b" }],
        },
      ],
    };

    const spec = toUiLevelNormalizedSpec(root, 1440, 900);
    assert.equal(spec.adapter, "figma");
    assert.deepEqual(spec.viewport, { width: 1440, height: 900 });
    assert.equal(spec.elements.length, 1);

    const elem = spec.elements[0]!;
    assert.equal(elem.figmaId, "10:1");
    assert.equal(elem.selector, '[data-figma-id="10:1"]');
    assert.equal(elem.styles["display"], "flex");
    assert.equal(elem.styles["flex-direction"], "row");
    assert.equal(elem.styles["gap"], "12px");
    assert.equal(elem.styles["background-color"], "#ffffff");
    assert.equal(elem.styles["border-radius"], "12px");

    const child = elem.children?.[0]!;
    assert.equal(child.figmaId, "10:2");
    assert.equal(child.text, "جستجو در سامانه...");
    assert.equal(child.styles["font-family"], "IRANSansXFaNum");
    assert.equal(child.styles["font-size"], "14px");
    assert.equal(child.styles["text-align"], "right");
    assert.deepEqual(child.rect, { x: 20, y: 16, width: 280, height: 32 });
  });
});
