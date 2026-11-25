/**
 * rtl-reference-fixture.js
 *
 * Reusable Figma design script for visual verification of Persian & bilingual RTL typography.
 * Pass this file's contents directly into `run_figma_js`.
 */
const primaryFont = { family: "IRANSansXFaNum", style: "Regular" };
const boldFont = { family: "IRANSansXFaNum", style: "Bold" };
const fallbackFont = { family: "Inter", style: "Regular" };

let activeFont = primaryFont;
let activeBold = boldFont;

try {
  await helpers.requireFont(primaryFont);
  await helpers.requireFont(boldFont);
} catch (err) {
  console.warn("IRANSansXFaNum not found, falling back to Inter: " + err.message);
  await figma.loadFontAsync(fallbackFont);
  activeFont = fallbackFont;
  activeBold = fallbackFont;
}

const card = figma.createFrame();
card.name = "RTL-Verification-Fixture";
card.resize(360, 480);
card.cornerRadius = 16;
card.fills = [{ type: "SOLID", color: { r: 0.98, g: 0.98, b: 0.99 } }];
card.strokes = [{ type: "SOLID", color: { r: 0.88, g: 0.9, b: 0.94 } }];
card.strokeWeight = 1;

helpers.setAutoLayout(card, {
  direction: "VERTICAL",
  spacing: 16,
  padding: 20,
  primarySizing: "AUTO",
  counterSizing: "FIXED",
  primaryAlign: "MIN",
  counterAlign: "MAX",
});

// 1. Title
const title = figma.createText();
title.name = "Title";
await helpers.setTextSafe(title, "کارت آزمون مرجع راست‌چین (RTL)", activeBold);
title.fontSize = 18;
title.textAlignHorizontal = "RIGHT";
card.appendChild(title);

// 2. Pure Persian Text
const p1 = figma.createText();
p1.name = "Pure-Persian";
await helpers.setTextSafe(
  p1,
  "این یک متن آزمایشی کاملاً فارسی برای بررسی شکل‌گیری صحیح حروف است.",
  activeFont,
);
p1.fontSize = 13;
p1.textAlignHorizontal = "RIGHT";
card.appendChild(p1);

// 3. Bilingual text with shortcut, digits and URL
const p2 = figma.createText();
p2.name = "Bilingual-Bidi";
await helpers.setTextSafe(
  p2,
  "کلید میانبر: Ctrl + K | شماره پیگیری: ۱۲۳۴۵۶ | آدرس: https://example.com",
  activeFont,
);
p2.fontSize = 12;
p2.textAlignHorizontal = "RIGHT";
card.appendChild(p2);

// 4. RTL Row (Icon/Badge + Label)
const row = figma.createFrame();
row.name = "RTL-Row";
row.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
row.cornerRadius = 8;
helpers.setAutoLayout(row, {
  direction: "HORIZONTAL",
  spacing: 8,
  padding: { top: 8, right: 12, bottom: 8, left: 12 },
  counterAlign: "CENTER",
});

const rowLabel = figma.createText();
rowLabel.name = "Row-Label";
await helpers.setTextSafe(rowLabel, "تنظیمات پیشرفته حساب کاربری", activeFont);
rowLabel.fontSize = 13;
rowLabel.textAlignHorizontal = "RIGHT";

const rowBadge = figma.createFrame();
rowBadge.name = "Badge";
rowBadge.resize(8, 8);
rowBadge.cornerRadius = 4;
rowBadge.fills = [{ type: "SOLID", color: { r: 0.06, g: 0.41, b: 0.92 } }];

row.appendChild(rowBadge);
row.appendChild(rowLabel);
card.appendChild(row);

// 5. Narrow-width truncation verification container
const narrowBox = figma.createFrame();
narrowBox.name = "Narrow-Truncation";
narrowBox.clipsContent = true;
narrowBox.fills = [{ type: "SOLID", color: { r: 0.94, g: 0.95, b: 0.97 } }];
narrowBox.cornerRadius = 6;
helpers.setAutoLayout(narrowBox, {
  direction: "HORIZONTAL",
  padding: { top: 6, right: 8, bottom: 6, left: 8 },
  primarySizing: "FIXED",
  counterSizing: "AUTO",
});
helpers.resizeFrameSafe(narrowBox, 140, 32, { primary: "FIXED", counter: "AUTO" });

const narrowText = figma.createText();
narrowText.name = "Truncated-Label";
await helpers.setTextSafe(narrowText, "متن بسیار طولانی برای تست برش در عرض کم", activeFont);
narrowText.fontSize = 12;
narrowText.textAlignHorizontal = "RIGHT";
narrowText.textTruncation = "ENDING";
narrowBox.appendChild(narrowText);
card.appendChild(narrowBox);

figma.currentPage.appendChild(card);
helpers.reveal([card]);

return {
  ok: true,
  cardId: card.id,
  name: card.name,
  fontUsed: activeFont.family,
  message: "RTL Reference Fixture created on canvas.",
};
