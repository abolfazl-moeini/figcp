import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WebCaptureResult } from "@figcp/shared";
import { SerialPluginExecutor } from "../../packages/plugin/src/executor.ts";
import { createPluginHelpers } from "../../packages/plugin/src/helpers.ts";
import { generateFigmaImportScript } from "../../packages/server/src/web-capture/figma-builder.ts";

describe("E2E Web Capture Script Execution in SerialPluginExecutor", () => {
  it("executes generated Figma script with getOrCreateVariable, missing font fallback, image fill, and state variants", async () => {
    const createdCollections: Array<{ id: string; name: string; modes: Array<{ modeId: string; name: string }> }> = [];
    const createdVariables: Array<{ id: string; name: string; variableCollectionId: string; values: Record<string, unknown> }> = [];
    const createdImages: string[] = [];
    const createdVariantSets: Array<{ name: string; count: number }> = [];
    let nextId = 1;

    const makeNode = (type: string) => {
      const children: any[] = [];
      return {
        id: `${nextId++}:1`,
        type,
        name: type,
        width: 100,
        height: 100,
        layoutMode: "NONE",
        children,
        fills: [],
        strokes: [],
        resize(w: number, h: number) {
          this.width = w;
          this.height = h;
          if (this.layoutMode !== "NONE") {
            this.primaryAxisSizingMode = "FIXED";
            this.counterAxisSizingMode = "FIXED";
          }
        },
        appendChild(child: any) {
          children.push(child);
        },
      };
    };

    const currentPage = {
      selection: [],
      children: [] as any[],
      appendChild(child: any) {
        this.children.push(child);
      },
    };

    const mockFigma: any = {
      currentPage,
      viewport: { scrollAndZoomIntoView() {} },
      commitUndo() {},
      async loadFontAsync(font: { family: string; style: string }) {
        if (font.family === "MissingWebFont") {
          throw new Error("Font not installed");
        }
      },
      async listAvailableFontsAsync() {
        return [{ fontName: { family: "Inter", style: "Regular" } }];
      },
      variables: {
        async getLocalVariableCollectionsAsync() {
          return createdCollections;
        },
        async getLocalVariablesAsync() {
          return createdVariables;
        },
        createVariableCollection(name: string) {
          const col = { id: `col-${createdCollections.length + 1}`, name, modes: [{ modeId: "m1", name: "Mode 1" }] };
          createdCollections.push(col);
          return col;
        },
        createVariable(name: string, collection: { id: string }, _resolvedType: string) {
          const v = {
            id: `var-${createdVariables.length + 1}`,
            name,
            variableCollectionId: collection.id,
            values: {} as Record<string, unknown>,
            setValueForMode(modeId: string, val: unknown) {
              this.values[modeId] = val;
            },
          };
          createdVariables.push(v);
          return v;
        },
        setBoundVariableForPaint(paint: any) {
          return paint;
        },
      },
      createFrame: () => makeNode("FRAME"),
      createText: () => makeNode("TEXT"),
      createComponent: () => makeNode("COMPONENT"),
      combineAsVariants(nodes: any[], parent: any) {
        const set = makeNode("COMPONENT_SET");
        createdVariantSets.push({ name: set.name, count: nodes.length });
        parent.appendChild(set);
        return set;
      },
      async createImageAsync(url: string) {
        createdImages.push(url);
        return { hash: "img-hash-1" };
      },
    };

    const capture: WebCaptureResult = {
      url: "https://example.com",
      title: "Test App",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      variables: { "--brand": "#2563eb", "--space-md": "16px" },
      breakpoints: [],
      fonts: [{ family: "MissingWebFont", weight: "400", status: "loaded" }],
      tree: {
        id: "web-1",
        tagName: "BODY",
        name: "Body",
        rect: { x: 0, y: 0, width: 1280, height: 800 },
        styles: { layoutMode: "VERTICAL", itemSpacing: 12, backgroundColor: "#ffffff" },
        children: [
          {
            id: "web-2",
            tagName: "P",
            name: "Greeting",
            rect: { x: 0, y: 0, width: 300, height: 24 },
            styles: { fontFamily: "MissingWebFont", fontSize: 16, color: "#111827" },
            text: "سلام دنیا",
            direction: "rtl",
          },
          {
            id: "web-3",
            tagName: "IMG",
            name: "Banner",
            rect: { x: 0, y: 36, width: 400, height: 200 },
            styles: {},
            imageUrl: "https://example.com/banner.png",
          },
        ],
      },
      states: [{ index: 0, kind: "menu", label: "Dropdown", changed: ["expanded"] }],
    };

    const script = generateFigmaImportScript(capture);
    const executor = new SerialPluginExecutor();
    const helpers = createPluginHelpers(mockFigma);
    const res = await executor.execute(script, mockFigma, helpers);

    assert.equal(res.ok, true, `Expected execution to succeed, got: ${res.error?.message}`);
    const out = res.result as { success: boolean; variablesCount: number; componentSetsCreated: number };
    assert.equal(out.success, true);
    assert.equal(out.variablesCount, 2);
    assert.equal(out.componentSetsCreated, 1);
    assert.equal(createdVariables.length, 2);
    assert.deepEqual(createdImages, ["https://example.com/banner.png"]);
    assert.equal(createdVariantSets.length, 1);
  });
});
