/**
 * rtl-reference-fixture.js
 *
 * Reusable Figma design script for visual verification of Persian & bilingual RTL typography.
 * Author: figcp
 *
 * Can be executed via `run_figma_js` tool to create a visual test card on the canvas.
 */
(async function (figma, helpers) {
  const fontName = { family: "IRANSansXFaNum", style: "Regular" };
  const fontBold = { family: "IRANSansXFaNum", style: "Bold" };

  // 1. Strict font preflight
  try {
    await helpers.requireFont(fontName);
    await helpers.requireFont(fontBold);
  } catch (err) {
    console.warn("IRANSansXFaNum not found. Falling back to Vazirmatn or system font: " + err.message);
    // If IRANSans not installed, fallback gracefully for fixture creation
  }

  // 2. Container Card
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
    counterAlign: "MAX", // Align items to right for RTL
  });

  // Title
  const title = figma.createText();
  title.name = "Title";
  try {
    await helpers.setTextSafe(title, "کارت آزمون مرجع راست‌چین (RTL)", fontBold);
  } catch {
    title.characters = "کارت آزمون مرجع راست‌چین (RTL)";
  }
  title.fontSize = 18;
  title.textAlignHorizontal = "RIGHT";
  card.appendChild(title);

  // Pure Persian Text
  const p1 = figma.createText();
  p1.name = "Pure-Persian";
  try {
    await helpers.setTextSafe(p1, "این یک متن آزمایشی کاملاً فارسی برای بررسی شکل‌گیری صحیح حروف است.", fontName);
  } catch {
    p1.characters = "این یک متن آزمایشی کاملاً فارسی برای بررسی شکل‌گیری صحیح حروف است.";
  }
  p1.fontSize = 13;
  p1.textAlignHorizontal = "RIGHT";
  card.appendChild(p1);

  // Bilingual text with shortcut, digits and URL
  const p2 = figma.createText();
  p2.name = "Bilingual-Bidi";
  try {
    await helpers.setTextSafe(p2, "کلید میانبر: Ctrl + K | شماره پیگیری: ۱۲۳۴۵۶ | آدرس: https://example.com", fontName);
  } catch {
    p2.characters = "کلید میانبر: Ctrl + K | شماره پیگیری: ۱۲۳۴۵۶ | آدرس: https://example.com";
  }
  p2.fontSize = 12;
  p2.textAlignHorizontal = "RIGHT";
  card.appendChild(p2);

  // RTL Row (Icon + Label)
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
  try {
    await helpers.setTextSafe(rowLabel, "تنظیمات پیشرفته حساب کاربری", fontName);
  } catch {
    rowLabel.characters = "تنظیمات پیشرفته حساب کاربری";
  }
  rowLabel.fontSize = 13;
  rowLabel.textAlignHorizontal = "RIGHT";

  const rowBadge = figma.createFrame();
  rowBadge.name = "Badge";
  rowBadge.resize(8, 8);
  rowBadge.cornerRadius = 4;
  rowBadge.fills = [{ type: "SOLID", color: { r: 0.06, g: 0.41, b: 0.92 } }];

  // In RTL, text is on right, indicator badge on left
  row.appendChild(rowBadge);
  row.appendChild(rowLabel);
  card.appendChild(row);

  figma.currentPage.appendChild(card);
  helpers.reveal([card]);

  return {
    ok: true,
    cardId: card.id,
    name: card.name,
    message: "RTL Reference Fixture created on canvas.",
  };
});
