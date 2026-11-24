import type { BoundingBox, LintIssue, NodeBoundsSummary } from "@figcp/shared";

const PERSIAN_ARABIC_RE = /[\u0600-\u06FF]/;
const LATIN_RE = /[A-Za-z]/;
const CONTAINER_OVERFLOW_TOLERANCE_PX = 1;
const OVERLAP_TOLERANCE_PX = 1;

function boxesOverlap(a: BoundingBox, b: BoundingBox): boolean {
  const xOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const yOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return xOverlap > OVERLAP_TOLERANCE_PX && yOverlap > OVERLAP_TOLERANCE_PX;
}

function childOverflowsParent(child: BoundingBox, parent: BoundingBox): boolean {
  return (
    child.x < parent.x - CONTAINER_OVERFLOW_TOLERANCE_PX ||
    child.y < parent.y - CONTAINER_OVERFLOW_TOLERANCE_PX ||
    child.x + child.width > parent.x + parent.width + CONTAINER_OVERFLOW_TOLERANCE_PX ||
    child.y + child.height > parent.y + parent.height + CONTAINER_OVERFLOW_TOLERANCE_PX
  );
}

function isVectorLike(type: string): boolean {
  return type === "VECTOR" || type === "BOOLEAN_OPERATION" || type === "LINE" || type === "STAR" || type === "POLYGON";
}

function hasBoundKey(bound: Record<string, unknown> | undefined, key: string): boolean {
  if (!bound) return false;
  const val = bound[key];
  if (Array.isArray(val)) return val.length > 0;
  return Boolean(val);
}

const PADDING_KEYS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;

export function lintNodeTree(root: NodeBoundsSummary): LintIssue[] {
  const issues: LintIssue[] = [];

  function walk(node: NodeBoundsSummary): void {
    if (node.visible === false || node.opacity === 0) return;

    // 1. Unbound solid fills / strokes on non-vector, non-mask nodes
    if (!isVectorLike(node.type) && node.isMask !== true) {
      const hasUnboundFill =
        node.unboundSolidFillCount !== undefined
          ? node.unboundSolidFillCount > 0
          : Boolean(node.hasVisibleSolidFill && !hasBoundKey(node.boundVariables, "fills"));

      if (hasUnboundFill && !node.fillStyleId) {
        issues.push({
          rule: "unbound-fill",
          severity: "warning",
          nodeId: node.id,
          nodeName: node.name,
          message: "Visible solid fill is not bound to a Color Variable or Paint Style.",
        });
      }

      const strokeVisible = node.strokeWeight === undefined || node.strokeWeight > 0;
      const hasUnboundStroke =
        node.unboundSolidStrokeCount !== undefined
          ? node.unboundSolidStrokeCount > 0
          : Boolean(node.hasVisibleSolidStroke && !hasBoundKey(node.boundVariables, "strokes"));

      if (strokeVisible && hasUnboundStroke && !node.strokeStyleId) {
        issues.push({
          rule: "unbound-stroke",
          severity: "warning",
          nodeId: node.id,
          nodeName: node.name,
          message: "Visible solid stroke is not bound to a Color Variable or Paint Style.",
        });
      }
    }

    // 2. Unbound Auto Layout spacing & padding
    if (node.layoutMode && node.layoutMode !== "NONE") {
      if (typeof node.itemSpacing === "number" && node.itemSpacing > 0 && !hasBoundKey(node.boundVariables, "itemSpacing")) {
        issues.push({
          rule: "unbound-spacing",
          severity: "info",
          nodeId: node.id,
          nodeName: node.name,
          message: `Auto Layout itemSpacing (${node.itemSpacing}px) is not bound to a spacing Variable.`,
        });
      }

      const unboundPads: string[] = [];
      for (const key of PADDING_KEYS) {
        const val = node[key];
        if (typeof val === "number" && val > 0 && !hasBoundKey(node.boundVariables, key)) {
          unboundPads.push(`${key}=${val}px`);
        }
      }
      if (unboundPads.length > 0) {
        issues.push({
          rule: "unbound-spacing",
          severity: "info",
          nodeId: node.id,
          nodeName: node.name,
          message: `Auto Layout padding (${unboundPads.join(", ")}) is not bound to spacing Variables.`,
        });
      }
    }

    // 3. Persian / RTL typography checks
    if (node.type === "TEXT" && typeof node.characters === "string") {
      const hasPersian = PERSIAN_ARABIC_RE.test(node.characters);
      if (hasPersian && node.textAlignHorizontal === "LEFT") {
        issues.push({
          rule: "rtl-alignment-mismatch",
          severity: "warning",
          nodeId: node.id,
          nodeName: node.name,
          message: 'Persian/Arabic text uses textAlignHorizontal="LEFT". Set it to "RIGHT" for RTL.',
        });
      }
      if (hasPersian && LATIN_RE.test(node.characters)) {
        issues.push({
          rule: "bilingual-rtl-check",
          severity: "info",
          nodeId: node.id,
          nodeName: node.name,
          message: "Text mixes Persian and Latin characters; verify visual bidi order via screenshot.",
        });
      }
    }

    const visibleChildren = (node.children ?? []).filter(
      (c) => c.visible !== false && c.opacity !== 0 && c.isMask !== true,
    );

    // 4. Child overflow check
    if (node.absoluteBoundingBox && !node.clipsContent) {
      for (const child of visibleChildren) {
        if (child.absoluteBoundingBox && childOverflowsParent(child.absoluteBoundingBox, node.absoluteBoundingBox)) {
          issues.push({
            rule: "child-overflow",
            severity: "error",
            nodeId: child.id,
            nodeName: child.name,
            message: `Child "${child.name}" overflows parent "${node.name}" bounding box.`,
          });
        }
      }
    }

    // 5. Sibling overlap check (for non-absolute siblings inside Auto Layout)
    if (node.layoutMode && node.layoutMode !== "NONE") {
      const flowChildren = visibleChildren.filter(
        (c) => c.layoutPositioning !== "ABSOLUTE" && c.absoluteBoundingBox,
      );
      for (let i = 0; i < flowChildren.length; i++) {
        for (let j = i + 1; j < flowChildren.length; j++) {
          const a = flowChildren[i]!;
          const b = flowChildren[j]!;
          if (boxesOverlap(a.absoluteBoundingBox!, b.absoluteBoundingBox!)) {
            issues.push({
              rule: "sibling-overlap",
              severity: "warning",
              nodeId: b.id,
              nodeName: b.name,
              message: `Sibling "${b.name}" overlaps "${a.name}" inside Auto Layout "${node.name}".`,
            });
          }
        }
      }
    }

    if (typeof node.truncatedChildrenCount === "number" && node.truncatedChildrenCount > 0) {
      issues.push({
        rule: "truncated-subtree",
        severity: "info",
        nodeId: node.id,
        nodeName: node.name,
        message: `Subtree truncated at maxDepth (${node.truncatedChildrenCount} child node(s) not inspected).`,
      });
    }

    for (const child of node.children ?? []) {
      if (child.visible !== false && child.opacity !== 0) {
        walk(child);
      }
    }
  }

  walk(root);
  return issues;
}
