import type { WebCaptureResult } from "@figcp/shared";

/**
 * Generates an executable Figma Plugin JS script from a WebCaptureResult.
 * Runs inside the Figma Desktop plugin worker (QuickJS) via `run_figma_js`.
 */
export function generateFigmaImportScript(capture: WebCaptureResult): string {
  const code = `
    const captureData = ${JSON.stringify(capture)};
    const { tree, variables, fonts, states } = captureData;

    // 1. Preload local fonts safely with Inter fallback
    const interLoaded = await helpers.loadFontSafe({ family: "Inter", style: "Regular" });
    for (const f of (fonts || [])) {
      if (f.family) {
        await helpers.loadFontSafe({ family: f.family, style: "Regular" });
      }
    }

    async function resolveLoadedFont(preferredFamily) {
      const family = preferredFamily || "Inter";
      const res = await helpers.loadFontSafe({ family, style: "Regular" });
      if (res && res.ok) {
        return { family, style: "Regular" };
      }
      if (interLoaded && interLoaded.ok) {
        return { family: "Inter", style: "Regular" };
      }
      const fallback = await helpers.loadFontSafe({ family: "Inter", style: "Regular" });
      if (fallback && fallback.ok) {
        return { family: "Inter", style: "Regular" };
      }
      return null;
    }

    // 2. Create Variables Collection for CSS variables using helpers.getOrCreateVariable
    const collectionName = "Web Imported (" + (captureData.title || "Page") + ")";
    let variablesCreated = 0;
    const varEntries = Object.entries(variables || {}).slice(0, 80);
    if (varEntries.length > 0 && figma.variables) {
      for (const [key, val] of varEntries) {
        const varName = key.replace(/^--/, "");
        try {
          if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(val)) {
            await helpers.getOrCreateVariable(collectionName, varName, "COLOR", val);
            variablesCreated++;
          } else if (/^-?[0-9]+(?:\\.[0-9]+)?px$/.test(val)) {
            const num = parseFloat(val);
            if (!isNaN(num)) {
              await helpers.getOrCreateVariable(collectionName, varName, "FLOAT", num);
              variablesCreated++;
            }
          }
        } catch (err) {
          console.warn("Skipping variable " + varName + ":", err && err.message ? err.message : String(err));
        }
      }
    }

    // 3. Build Figma node tree recursively
    async function buildNode(el, parent) {
      if (!el) return null;
      const s = el.styles || {};
      let node = null;

      if (el.tagName === "SVG" && el.inlineSvg && typeof figma.createNodeFromSvg === "function") {
        try {
          node = figma.createNodeFromSvg(el.inlineSvg);
          node.name = el.name || "SVG";
        } catch {
          node = figma.createFrame();
        }
      } else if (el.tagName === "TEXT" || (el.text && (!el.children || el.children.length === 0))) {
        node = figma.createText();
        node.name = el.name || "Text";
        const fontName = await resolveLoadedFont(s.fontFamily);
        if (fontName) {
          node.fontName = fontName;
          if (s.fontSize) node.fontSize = s.fontSize;
          if (s.lineHeight) node.lineHeight = { value: s.lineHeight, unit: "PIXELS" };
          if (el.text) node.characters = el.text;
        }
        if (s.color) {
          node.fills = [{ type: "SOLID", color: helpers.hexToRgb(s.color.slice(0, 7)) }];
        }
      } else {
        node = figma.createFrame();
        node.name = el.name || el.tagName || "Container";
        node.clipsContent = false;

        const w = Math.max(1, (el.rect && el.rect.width) || 100);
        const h = Math.max(1, (el.rect && el.rect.height) || 100);
        helpers.resizeFrameSafe(node, w, h);

        if (s.layoutMode === "HORIZONTAL" || s.layoutMode === "VERTICAL") {
          helpers.setAutoLayout(node, {
            direction: s.layoutMode,
            spacing: s.itemSpacing,
            padding: s.padding,
            primarySizing: "FIXED",
            counterSizing: "FIXED",
          });
          if (s.flexWrap && "layoutWrap" in node) {
            node.layoutWrap = "WRAP";
          }
        }

        if (el.imageUrl && typeof figma.createImageAsync === "function") {
          try {
            const img = await figma.createImageAsync(el.imageUrl);
            node.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash }];
          } catch {
            node.fills = s.backgroundColor
              ? [{ type: "SOLID", color: helpers.hexToRgb(s.backgroundColor.slice(0, 7)) }]
              : [];
          }
        } else if (s.backgroundColor) {
          node.fills = [{ type: "SOLID", color: helpers.hexToRgb(s.backgroundColor.slice(0, 7)) }];
        } else {
          node.fills = [];
        }

        if (s.borderColor && s.borderWidth) {
          node.strokes = [{ type: "SOLID", color: helpers.hexToRgb(s.borderColor.slice(0, 7)) }];
          node.strokeWeight = s.borderWidth;
        }

        if (s.borderRadius) {
          node.cornerRadius = s.borderRadius;
        }

        if (el.children && el.children.length > 0) {
          for (const child of el.children) {
            await buildNode(child, node);
          }
        }
      }

      if (node && parent) {
        parent.appendChild(node);
      }
      return node;
    }

    const pageRoot = figma.createFrame();
    pageRoot.name = "Web Import: " + (captureData.title || captureData.url);
    helpers.resizeFrameSafe(
      pageRoot,
      (captureData.viewport && captureData.viewport.width) || 1440,
      (captureData.viewport && captureData.viewport.height) || 900,
    );
    figma.currentPage.appendChild(pageRoot);

    if (tree && tree.children) {
      for (const child of tree.children) {
        await buildNode(child, pageRoot);
      }
    } else if (tree) {
      await buildNode(tree, pageRoot);
    }

    // 4. Generate Component Variants for captured interactive states when supported
    let componentSetsCreated = 0;
    if (Array.isArray(states) && states.length > 0 && typeof figma.createComponent === "function" && typeof figma.combineAsVariants === "function") {
      for (const st of states) {
        try {
          const defComp = figma.createComponent();
          defComp.name = "State=Default";
          helpers.resizeFrameSafe(defComp, 180, 44);
          const openComp = figma.createComponent();
          openComp.name = "State=Open";
          helpers.resizeFrameSafe(openComp, 180, 120);
          figma.currentPage.appendChild(defComp);
          figma.currentPage.appendChild(openComp);
          const set = figma.combineAsVariants([defComp, openComp], figma.currentPage);
          set.name = (st.kind || "control") + ": " + (st.label || st.index);
          componentSetsCreated++;
        } catch (err) {
          console.warn("Could not create state variant:", err && err.message ? err.message : String(err));
        }
      }
    }

    figma.viewport.scrollAndZoomIntoView([pageRoot]);
    return {
      success: true,
      rootId: pageRoot.id,
      name: pageRoot.name,
      variablesCount: variablesCreated,
      componentSetsCreated,
    };
  `;

  return code;
}
