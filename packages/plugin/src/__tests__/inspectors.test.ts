import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  handleExportNodeAssets,
  handleFigmaUndo,
  handleGetDesignContext,
  handleInspectDesignSystem,
  handleInspectNodeBounds,
} from "../inspectors.ts";

describe("plugin inspectors", () => {
  it("inspects variables (with alias resolution), styles, component sets, and filtered fonts", async () => {
    const mockFigma = {
      root: {
        name: "Bidar DS",
        children: [
          {
            name: "Components",
            loadAsync: async () => {},
            findAll: () => [
              {
                id: "10:1",
                name: "Search Box",
                type: "COMPONENT_SET",
                children: new Array(16).fill({}),
                componentPropertyDefinitions: { Text: { type: "TEXT", defaultValue: "جستجو..." } },
              },
            ],
          },
        ],
      },
      currentPage: { name: "Components", selection: [] },
      variables: {
        getLocalVariableCollectionsAsync: async () => [
          { id: "col1", name: "Colors-Semantic", modes: [{ modeId: "m1", name: "Mode 1" }] },
        ],
        getLocalVariablesAsync: async () => [
          { id: "v1", name: "blue/500", variableCollectionId: "col1", resolvedType: "COLOR", valuesByMode: { m1: { r: 0, g: 0, b: 1 } } },
          { id: "v2", name: "border/focus", variableCollectionId: "col1", resolvedType: "COLOR", valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "v1" } } },
          { id: "v3", name: "input/focus-ring", variableCollectionId: "col1", resolvedType: "COLOR", valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "v2" } } },
        ],
      },
      getLocalPaintStylesAsync: async () => [],
      getLocalTextStylesAsync: async () => [
        { id: "ts1", name: "Desktop/Label", fontName: { family: "IRANSansXFaNum", style: "Regular" }, fontSize: 14 },
      ],
      getLocalEffectStylesAsync: async () => [{ id: "es1", name: "ring/focus-brand" }],
      listAvailableFontsAsync: async () => [
        { fontName: { family: "IRANSansXFaNum", style: "Regular" } },
        { fontName: { family: "Inter", style: "Regular" } },
      ],
    } as unknown as PluginAPI;

    const snapshot = await handleInspectDesignSystem(mockFigma, { fontQuery: "IRANSans" });
    assert.equal(snapshot.fileName, "Bidar DS");
    assert.equal(snapshot.variableCollections[0]?.variables[1]?.valuesByMode.m1, '{blue/500} = "#0000ff"');
    assert.equal(
      snapshot.variableCollections[0]?.variables[2]?.valuesByMode.m1,
      '{border/focus -> blue/500} = "#0000ff"',
    );
    assert.equal(snapshot.componentSets[0]?.variantCount, 16);
    assert.equal(snapshot.fonts?.length, 1);
    assert.equal(snapshot.fonts?.[0]?.family, "IRANSansXFaNum");
  });

  it("normalizes nodeId, inspects bounds, detects partial fill bindings, marks truncation, and caps PNG size", async () => {
    let queriedId = "";
    const mockNode = {
      id: "5031:4449",
      name: "Search Box",
      type: "FRAME",
      visible: true,
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      absoluteBoundingBox: { x: 0, y: 0, width: 340, height: 44 },
      absoluteRenderBounds: { x: 0, y: 0, width: 340, height: 44 },
      fills: [
        { type: "SOLID", visible: true, boundVariables: { color: { id: "v1" } } },
        { type: "SOLID", visible: true },
      ],
      boundVariables: { fills: [{ id: "v1" }] },
      children: [{ id: "5031:4450", name: "Child", type: "TEXT" }],
      exportAsync: async () => new Uint8Array([137, 80, 78, 71]),
    };

    const mockFigma = {
      getNodeByIdAsync: async (id: string) => {
        queriedId = id;
        return mockNode;
      },
      currentPage: { selection: [] },
    } as unknown as PluginAPI;

    const out = await handleInspectNodeBounds(mockFigma, {
      nodeId: "5031-4449",
      maxDepth: 0,
      includeScreenshot: true,
    });
    assert.equal(queriedId, "5031:4449");
    assert.equal(out.node.absoluteBoundingBox?.width, 340);
    assert.equal(out.node.unboundSolidFillCount, 1);
    assert.equal(out.node.truncatedChildrenCount, 1);
    assert.equal(out.screenshotBase64, "iVBORw==");

    // Oversized PNG rejection
    mockNode.exportAsync = async () => new Uint8Array(10 * 1024 * 1024 + 1);
    await assert.rejects(
      () => handleInspectNodeBounds(mockFigma, { nodeId: "5031:4449", includeScreenshot: true }),
      /exceeds max safe payload/,
    );
  });

  it("supports undo and version snapshot actions", async () => {
    let undone = false;
    let savedTitle = "";
    const mockFigma = {
      triggerUndo: () => {
        undone = true;
      },
      saveVersionHistoryAsync: async (title: string) => {
        savedTitle = title;
      },
    } as unknown as PluginAPI;

    const u = await handleFigmaUndo(mockFigma, { action: "undo" });
    assert.equal(u.ok, true);
    assert.equal(undone, true);

    const s = await handleFigmaUndo(mockFigma, { action: "snapshot", title: "Before Refactor" });
    assert.equal(s.action, "snapshot");
    assert.equal(savedTitle, "Before Refactor");
  });

  it("extracts design context with relativeRect and exports SVG/PNG assets cleanly", async () => {
    const mockNode = {
      id: "200:1",
      name: "Icon",
      type: "FRAME",
      x: 16,
      y: 24,
      width: 48,
      height: 48,
      absoluteBoundingBox: { x: 100, y: 200, width: 48, height: 48 },
      exportAsync: async (opts: { format: string }) => {
        if (opts.format === "PNG") {
          return new Uint8Array([137, 80, 78, 71]);
        }
        return new TextEncoder().encode("<svg viewBox='0 0 48 48'></svg>");
      },
    };

    const mockFigma = {
      getNodeByIdAsync: async () => mockNode,
      currentPage: { selection: [mockNode] },
    } as unknown as PluginAPI;

    const ctx = await handleGetDesignContext(mockFigma, { nodeId: "200:1" });
    assert.equal(ctx.root.id, "200:1");
    assert.equal(ctx.root.rect.width, 48);
    assert.deepEqual(ctx.root.relativeRect, { x: 16, y: 24, width: 48, height: 48 });

    const svgAsset = await handleExportNodeAssets(mockFigma, { nodeId: "200:1", format: "SVG" });
    assert.equal(svgAsset.ok, true);
    assert.equal(svgAsset.format, "SVG");
    assert.ok(svgAsset.content.includes("<svg"));

    const pngAsset = await handleExportNodeAssets(mockFigma, { nodeId: "200:1", format: "PNG" });
    assert.equal(pngAsset.ok, true);
    assert.equal(pngAsset.format, "PNG");
    assert.equal(pngAsset.content, "iVBORw==");
  });
});
