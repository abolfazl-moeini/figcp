import { z } from "zod";

export const WebColorHexSchema = z.string().regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);

export interface WebCaptureElement {
  id: string;
  tagName: string;
  role?: string;
  name?: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  styles: {
    display?: string;
    layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
    flexWrap?: boolean;
    primarySizing?: string;
    counterSizing?: string;
    itemSpacing?: number;
    rowGap?: number;
    columnGap?: number;
    perRow?: number;
    maxWidth?: number;
    padding?: {
      top: number;
      right: number;
      bottom: number;
      left: number;
    };
    backgroundColor?: string;
    color?: string;
    borderRadius?: number;
    borderWidth?: number;
    borderColor?: string;
    boxShadow?: string;
    opacity?: number;
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number | string;
    lineHeight?: number;
    textAlign?: string;
  };
  text?: string;
  direction?: "ltr" | "rtl";
  attributes?: Record<string, string>;
  inlineSvg?: string;
  imageUrl?: string;
  children?: WebCaptureElement[];
}

export const WebCaptureElementSchema: z.ZodType<WebCaptureElement> = z.lazy(() =>
  z.object({
    id: z.string(),
    tagName: z.string(),
    role: z.string().optional(),
    name: z.string().optional(),
    rect: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
    styles: z.object({
      display: z.string().optional(),
      layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]).optional(),
      flexWrap: z.boolean().optional(),
      primarySizing: z.string().optional(),
      counterSizing: z.string().optional(),
      itemSpacing: z.number().optional(),
      rowGap: z.number().optional(),
      columnGap: z.number().optional(),
      perRow: z.number().optional(),
      maxWidth: z.number().optional(),
      padding: z
        .object({
          top: z.number(),
          right: z.number(),
          bottom: z.number(),
          left: z.number(),
        })
        .optional(),
      backgroundColor: z.string().optional(),
      color: z.string().optional(),
      borderRadius: z.number().optional(),
      borderWidth: z.number().optional(),
      borderColor: z.string().optional(),
      boxShadow: z.string().optional(),
      opacity: z.number().optional(),
      fontFamily: z.string().optional(),
      fontSize: z.number().optional(),
      fontWeight: z.union([z.number(), z.string()]).optional(),
      lineHeight: z.number().optional(),
      textAlign: z.string().optional(),
    }),
    text: z.string().optional(),
    direction: z.enum(["ltr", "rtl"]).optional(),
    attributes: z.record(z.string()).optional(),
    inlineSvg: z.string().optional(),
    imageUrl: z.string().optional(),
    children: z.array(z.lazy(() => WebCaptureElementSchema)).optional(),
  })
);

export const WebCapturedStateSchema = z.object({
  index: z.number(),
  kind: z.enum(["menu", "dialog", "tab", "section", "toggle"]),
  label: z.string(),
  changed: z.array(z.string()),
  screenshotBase64: z.string().optional(),
  elementTree: WebCaptureElementSchema.optional(),
});
export type WebCapturedState = z.infer<typeof WebCapturedStateSchema>;

export const WebCaptureResultSchema = z.object({
  url: z.string(),
  title: z.string(),
  viewport: z.object({
    width: z.number(),
    height: z.number(),
    deviceScaleFactor: z.number(),
  }),
  variables: z.record(z.string()), // CSS custom properties
  breakpoints: z.array(
    z.object({
      query: z.string(),
      px: z.number(),
      count: z.number(),
    })
  ),
  fonts: z.array(
    z.object({
      family: z.string(),
      weight: z.string().optional(),
      status: z.string().optional(),
    })
  ),
  tree: WebCaptureElementSchema,
  states: z.array(WebCapturedStateSchema).optional(),
});
export type WebCaptureResult = z.infer<typeof WebCaptureResultSchema>;
