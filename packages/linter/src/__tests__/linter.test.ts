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

  it("flags rtl-font-mismatch when Persian text uses Latin default fonts", () => {
    const textNode: NodeBoundsSummary = {
      id: "5:1",
      name: "PersianInter",
      type: "TEXT",
      characters: "متن با فونت پیش‌فرض",
      textAlignHorizontal: "RIGHT",
      fontName: { family: "Inter", style: "Regular" },
    };
    const issues = lintNodeTree(textNode);
    assert.ok(issues.some((i) => i.rule === "rtl-font-mismatch"));
  });

  it("downgrades child-overflow to info when child has layoutPositioning ABSOLUTE", () => {
    const parent: NodeBoundsSummary = {
      id: "6:1",
      name: "Parent",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      children: [
        {
          id: "6:2",
          name: "Badge",
          type: "FRAME",
          layoutPositioning: "ABSOLUTE",
          absoluteBoundingBox: { x: 90, y: -10, width: 24, height: 24 },
        },
      ],
    };
    const issues = lintNodeTree(parent);
    const overflow = issues.find((i) => i.rule === "child-overflow");
    assert.ok(overflow);
    assert.equal(overflow.severity, "info");
  });

  it("uses letters for RTL, treats font hints as advisory, and reports overlap budget skips", () => {
    const root: NodeBoundsSummary = {
      id: "root", name: "Root", type: "FRAME", layoutMode: "VERTICAL", itemSpacing: -8,
      children: [
        { id: "digits", name: "Digits", type: "TEXT", characters: "123٤٥٦ !؟", textAlignHorizontal: "LEFT" },
        { id: "latin", name: "Latin", type: "TEXT", characters: "hello فارسی", textAlignHorizontal: "LEFT", fontName: { family: "Inter", style: "Regular" } },
        ...Array.from({ length: 51 }, (_, index) => ({
          id: `n${index}`, name: `N${index}`, type: "FRAME" as const,
          absoluteBoundingBox: { x: 0, y: 0, width: 5, height: 5 },
        })),
      ],
    };
    const issues = lintNodeTree(root);
    assert.equal(issues.some((issue) => issue.nodeId === "digits" && issue.rule === "rtl-alignment-mismatch"), false);
    const fontHint = issues.find((issue) => issue.nodeId === "latin" && issue.rule === "rtl-font-mismatch");
    assert.equal(fontHint?.severity, "info");
    assert.equal(issues.some((issue) => issue.rule === "sibling-overlap"), false);
    assert.ok(issues.some((issue) => issue.rule === "overlap-check-truncated"));
  });
});
