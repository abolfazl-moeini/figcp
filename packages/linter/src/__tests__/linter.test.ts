import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NodeBoundsSummary } from "@figcp/shared";
import { lintNodeTree } from "../rules.ts";

describe("@figcp/linter", () => {
  it("flags child-overflow, sibling-overlap, unbound-fill, unbound-spacing, and rtl-alignment-mismatch", () => {
    const broken: NodeBoundsSummary = {
      id: "1:1",
      name: "Card",
      type: "FRAME",
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      hasVisibleSolidFill: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 44 },
      children: [
        {
          id: "1:2",
          name: "Title",
          type: "TEXT",
          characters: "جستجو در دوره‌ها",
          textAlignHorizontal: "LEFT",
          absoluteBoundingBox: { x: 10, y: 10, width: 120, height: 24 },
        },
        {
          id: "1:3",
          name: "OverflowBadge",
          type: "FRAME",
          absoluteBoundingBox: { x: 100, y: 10, width: 150, height: 24 },
        },
      ],
    };

    const issues = lintNodeTree(broken);
    const rules = new Set(issues.map((i) => i.rule));
    assert.ok(rules.has("unbound-fill"));
    assert.ok(rules.has("unbound-spacing"));
    assert.ok(rules.has("rtl-alignment-mismatch"));
    assert.ok(rules.has("child-overflow"));
    assert.ok(rules.has("sibling-overlap"));
  });

  it("flags bilingual Persian + Latin text for visual verification", () => {
    const textNode: NodeBoundsSummary = {
      id: "2:1",
      name: "Hint",
      type: "TEXT",
      characters: "جستجو (Ctrl + K)",
      textAlignHorizontal: "RIGHT",
    };
    const issues = lintNodeTree(textNode);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.rule, "bilingual-rtl-check");
  });

  it("returns zero issues for a properly bound RTL Search Box", () => {
    const clean: NodeBoundsSummary = {
      id: "3:1",
      name: "Search Box",
      type: "COMPONENT",
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      hasVisibleSolidFill: true,
      hasVisibleSolidStroke: true,
      boundVariables: {
        fills: [{ id: "v_bg" }],
        strokes: [{ id: "v_border" }],
        itemSpacing: { id: "v_gap8" },
      },
      absoluteBoundingBox: { x: 0, y: 0, width: 340, height: 44 },
      children: [
        {
          id: "3:2",
          name: "Query Text",
          type: "TEXT",
          characters: "جستجو در مراکز، دوره‌ها و اخبار...",
          textAlignHorizontal: "RIGHT",
          absoluteBoundingBox: { x: 12, y: 12, width: 280, height: 20 },
        },
        {
          id: "3:3",
          name: "Search Icon",
          type: "INSTANCE",
          absoluteBoundingBox: { x: 300, y: 12, width: 20, height: 20 },
        },
      ],
    };

    assert.deepEqual(lintNodeTree(clean), []);
  });

  it("flags unbound padding, partially bound fills, and truncated subtrees while skipping opacity-0/mask nodes", () => {
    const node: NodeBoundsSummary = {
      id: "4:1",
      name: "PaddedBox",
      type: "FRAME",
      layoutMode: "HORIZONTAL",
      paddingTop: 12,
      paddingLeft: 16,
      hasVisibleSolidFill: true,
      unboundSolidFillCount: 1,
      truncatedChildrenCount: 3,
      children: [
        {
          id: "4:2",
          name: "HiddenOpacity",
          type: "RECTANGLE",
          opacity: 0,
          hasVisibleSolidFill: true,
          unboundSolidFillCount: 1,
        },
        {
          id: "4:3",
          name: "MaskShape",
          type: "RECTANGLE",
          isMask: true,
          hasVisibleSolidFill: true,
          unboundSolidFillCount: 1,
        },
      ],
    };

    const issues = lintNodeTree(node);
    const rules = issues.map((i) => i.rule);
    assert.ok(rules.includes("unbound-spacing"));
    assert.ok(rules.includes("unbound-fill"));
    assert.ok(rules.includes("truncated-subtree"));
    assert.equal(issues.some((i) => i.nodeId === "4:2" || i.nodeId === "4:3"), false);
  });
});
