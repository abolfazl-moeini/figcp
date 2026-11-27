import { CdpClient } from "./cdp-client.ts";
import {
  REVEAL_PAGE_SCRIPT,
  EXTRACT_WEB_PAGE_SCRIPT,
  FIND_CONTROLS_SCRIPT,
  STATE_CHECK_SCRIPT,
  REMEMBER_TAB_SCRIPT,
  RESELECT_TAB_SCRIPT,
  CLICK_CONTROL_SCRIPT,
} from "./dom-scripts.ts";
import type { WebCaptureResult, WebCapturedState } from "@figcp/shared";

export interface CaptureOptions {
  url?: string;
  cdpEndpoint?: string;
  width?: number;
  height?: number;
  colorScheme?: "light" | "dark";
  captureStates?: boolean;
  maxStates?: number;
}

interface StateSnapshot {
  present: boolean;
  expanded: string | null;
  selected: string | null;
  open: boolean | null;
  dialogs: number;
  url: string;
}

function diffStates(before: StateSnapshot, after: StateSnapshot): string[] {
  const changed: string[] = [];
  if (after.expanded === "true" && before.expanded !== "true") changed.push("expanded");
  if (after.selected === "true" && before.selected !== "true") changed.push("tab selected");
  if (after.open === true && before.open !== true) changed.push("section opened");
  if (after.dialogs > before.dialogs) changed.push("dialog appeared");
  if (after.url !== before.url) changed.push("address changed");
  return changed.length > 0 ? changed : ["opened"];
}

export class WebCaptureManager {
  /**
   * Captures a web page either by attaching to an existing browser tab (via CDP)
   * or by connecting to a running Chromium loopback endpoint.
   */
  static async captureWeb(options: CaptureOptions): Promise<WebCaptureResult> {
    const endpoint = options.cdpEndpoint || "127.0.0.1:9222";
    const pages = await CdpClient.findPages(endpoint);
    if (!pages || pages.length === 0) {
      throw new Error(`No accessible browser pages found on CDP endpoint ${endpoint}`);
    }

    let target = pages.find((p) => p.type === "page") ?? pages[0];
    if (options.url) {
      const match = pages.find((p) => p.url && p.url.includes(options.url!));
      if (match) target = match;
    }

    if (!target?.webSocketDebuggerUrl) {
      throw new Error("Target page does not have an active webSocketDebuggerUrl");
    }

    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();

    try {
      // 1. Normalize viewport and environment
      const width = options.width || 1440;
      const height = options.height || 900;
      await client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });

      await client.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: options.colorScheme ?? "light" }],
      });

      // Dismiss any open modals or overlays by pressing Escape
      try {
        await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 27, code: "Escape", key: "Escape" });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, code: "Escape", key: "Escape" });
      } catch {
        // Best-effort
      }

      // 2. Scroll and reveal full assets
      await client.eval(REVEAL_PAGE_SCRIPT);

      // 3. Extract DOM, tokens, Auto Layout, and fonts
      const result = await client.eval<WebCaptureResult>(EXTRACT_WEB_PAGE_SCRIPT);

      // 4. Capture interactive states if requested
      if (options.captureStates) {
        const maxStates = options.maxStates || 5;
        const found = await client.eval<Array<{ index: number; kind: WebCapturedState["kind"]; label: string }>>(FIND_CONTROLS_SCRIPT);

        // Best-effort discovery of non-semantic clickables via DOMDebugger.getEventListeners
        try {
          const doc = await client.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 1 });
          if (doc?.root?.nodeId) {
            const resolved = await client.send<{ object: { objectId?: string } }>("DOM.resolveNode", { nodeId: doc.root.nodeId });
            if (resolved?.object?.objectId) {
              await client.send("DOMDebugger.getEventListeners", { objectId: resolved.object.objectId, depth: 2 }).catch(() => undefined);
            }
          }
        } catch {
          // Optional CDP domain
        }

        const states: WebCapturedState[] = [];
        for (const item of (found || []).slice(0, maxStates)) {
          const before = await client.eval<StateSnapshot>(STATE_CHECK_SCRIPT(item.index));
          await client.eval(REMEMBER_TAB_SCRIPT(item.index));
          const clicked = await client.eval<boolean>(CLICK_CONTROL_SCRIPT(item.index));
          if (!clicked) continue;

          await new Promise((r) => setTimeout(r, 350));
          const after = await client.eval<StateSnapshot>(STATE_CHECK_SCRIPT(item.index));
          const changed = diffStates(before, after);

          let screenshotBase64: string | undefined;
          if (!changed.includes("address changed")) {
            const shot = await client.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
            screenshotBase64 = shot?.data;
          }

          states.push({
            index: item.index,
            kind: item.kind,
            label: item.label,
            changed,
            screenshotBase64,
          });

          // Put the page back to initial state
          try {
            await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 27, code: "Escape", key: "Escape" });
            await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, code: "Escape", key: "Escape" });
          } catch {
            // Best-effort
          }
          if (after.expanded === "true" || after.open === true) {
            await client.eval(CLICK_CONTROL_SCRIPT(item.index));
          } else if (changed.includes("tab selected")) {
            await client.eval(RESELECT_TAB_SCRIPT(item.index));
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        result.states = states;
      }

      return result;
    } finally {
      client.close();
    }
  }
}
