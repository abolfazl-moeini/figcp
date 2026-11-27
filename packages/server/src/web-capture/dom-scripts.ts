/**
 * In-browser evaluation scripts for Live Web DOM & token extraction.
 * Inspired by craft-anything's REVEAL_JS, BLUEPRINT_JS, LAYOUT_JS, and FIND_STATES_JS patterns.
 */

export const REVEAL_PAGE_SCRIPT = `(async () => {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + 5000;
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  const bottom = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) - window.innerHeight;
  let y = 0;
  while (y < bottom() && Date.now() < end) {
    y = Math.min(y + step, bottom());
    window.scrollTo(0, y);
    await pause(100);
  }
  for (const img of document.images) {
    if (img.loading === 'lazy') img.loading = 'eager';
  }
  const loading = [...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => {
    i.addEventListener('load', r, { once: true });
    i.addEventListener('error', r, { once: true });
  }));
  await Promise.race([Promise.all(loading), pause(Math.max(300, end - Date.now()))]);
  window.scrollTo(0, 0);
  await pause(150);
  return true;
})()`;

export const EXTRACT_WEB_PAGE_SCRIPT = `(() => {
  const px = (v) => Math.round(parseFloat(v) || 0);
  const cap = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n);

  const sanitizeUrl = (raw, stripAllQuery) => {
    if (!raw) return raw;
    try {
      const u = new URL(raw, window.location.href);
      if (stripAllQuery) {
        return u.origin + u.pathname;
      }
      const sensitive = /^(token|access_token|auth|key|api_key|secret|password|session|sid|sig|signature|code)$/i;
      for (const k of Array.from(u.searchParams.keys())) {
        if (sensitive.test(k)) {
          u.searchParams.delete(k);
        }
      }
      u.hash = '';
      return u.toString();
    } catch {
      return raw.split('?')[0].split('#')[0];
    }
  };

  // 1x1 Canvas for converting modern CSS colors (oklch, color-mix, etc.) to clean hex
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const seenHex = {};

  const toHex = (c) => {
    if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return undefined;
    if (c in seenHex) return seenHex[c];
    const h2 = (x) => x.toString(16).padStart(2, '0');
    const m = /^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(c);
    if (m) {
      const a = m[4] === undefined ? 1 : +m[4];
      const hex = '#' + h2(+m[1]) + h2(+m[2]) + h2(+m[3]) + (a < 1 ? h2(Math.round(a * 255)) : '');
      return (seenHex[c] = hex);
    }
    if (!g) return c;
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = '#000000';
    g.fillStyle = c;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    const hex = '#' + h2(d[0]) + h2(d[1]) + h2(d[2]) + (d[3] < 255 ? h2(d[3]) : '');
    return (seenHex[c] = hex);
  };

  // Extract CSS variables and media query breakpoints
  const variables = {};
  const bps = {};
  const bp = (side, n, unit) => {
    const val = side + '-width ' + Math.round(parseFloat(n) * (unit === 'px' ? 1 : 16)) + 'px';
    bps[val] = (bps[val] || 0) + 1;
  };

  let ruleCount = 0;
  const walkRules = (rules, depth) => {
    if (!rules || depth > 6) return;
    for (const r of Array.from(rules)) {
      if (++ruleCount > 20000) return;
      if (r.selectorText && r.selectorText.includes(':root') && r.style) {
        for (const name of Array.from(r.style)) {
          if (name.startsWith('--') && Object.keys(variables).length < 500) {
            variables[name] = cap(r.style.getPropertyValue(name), 120);
          }
        }
      }
      const media = r.media && r.media.mediaText ? r.media.mediaText : (r.conditionText || '');
      for (const m of media.matchAll(/(min|max)-width\\s*:\\s*([\\d.]+)(px|r?em)/g)) bp(m[1], m[2], m[3]);
      for (const m of media.matchAll(/width\\s*(>=?|<=?)\\s*([\\d.]+)(px|r?em)/g)) bp(m[1][0] === '>' ? 'min' : 'max', m[2], m[3]);
      if (r.cssRules) walkRules(r.cssRules, depth + 1);
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walkRules(sheet.cssRules, 0);
    } catch {
      // Cross-origin stylesheet access blocked
    }
  }

  const breakpoints = Object.entries(bps)
    .map(([query, count]) => ({ query, px: parseInt(query.split(' ')[1], 10), count }))
    .sort((a, b) => a.px - b.px)
    .slice(0, 24);

  // Extract document loaded fonts
  const fonts = [];
  if (document.fonts) {
    for (const f of Array.from(document.fonts)) {
      const cleanFamily = f.family.replace(/^['"]|['"]$/g, '').replace(/^__([a-zA-Z0-9\\s-]+?)_[0-9a-f]{5,}$/i, '$1');
      fonts.push({ family: cleanFamily, weight: f.weight, status: f.status });
    }
  }

  const isShown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  // Compute per_row using >=15% parent width filter and 2px vertical tolerance
  const computePerRow = (parentWidth, children) => {
    if (!children || children.length < 2) return 1;
    const minW = Math.max(40, parentWidth * 0.15);
    const wide = children.filter((c) => c.rect.width >= minW);
    if (wide.length < 2) return 1;
    const firstTop = wide[0].rect.y;
    const rowCount = wide.filter((c) => Math.abs(c.rect.y - firstTop) <= 2).length;
    return Math.max(1, rowCount);
  };

  const inferLayout = (el, style, rect, children) => {
    const display = style.display || '';
    const perRow = computePerRow(rect.width, children);
    const maxWidth = style.maxWidth && style.maxWidth.endsWith('px') ? px(style.maxWidth) : undefined;

    if (display.includes('flex')) {
      const isHorizontal = (style.flexDirection || '').includes('row');
      return {
        layoutMode: isHorizontal ? 'HORIZONTAL' : 'VERTICAL',
        flexWrap: style.flexWrap === 'wrap',
        perRow,
        maxWidth,
      };
    }
    if (display.includes('grid')) {
      return { layoutMode: 'GRID', perRow, maxWidth };
    }
    if (children && children.length > 1) {
      if (perRow > 1) {
        return { layoutMode: 'HORIZONTAL', perRow, maxWidth };
      }
      return { layoutMode: 'VERTICAL', perRow: 1, maxWidth };
    }
    return { layoutMode: 'NONE', perRow: 1, maxWidth };
  };

  let nodeCounter = 0;
  const extractTree = (el, depth = 0) => {
    if (depth > 20 || nodeCounter > 5000) return null;
    if (!isShown(el)) return null;

    const rect = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const tagName = el.tagName.toUpperCase();

    let inlineSvg = undefined;
    if (tagName === 'SVG') {
      inlineSvg = el.outerHTML;
    }

    let imageUrl = undefined;
    if (tagName === 'IMG' && el.src) {
      imageUrl = sanitizeUrl(el.src, false);
    }

    let text = undefined;
    const textNodes = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (textNodes.length > 0) {
      text = textNodes.map((n) => n.textContent).join(' ').trim();
    }

    let borderRadius = px(s.borderRadius);
    if (borderRadius > 9999 || (s.borderRadius && s.borderRadius.includes('e+'))) {
      borderRadius = 9999;
    }

    const padTop = px(s.paddingTop);
    const padRight = px(s.paddingRight);
    const padBottom = px(s.paddingBottom);
    const padLeft = px(s.paddingLeft);
    const hasPadding = padTop > 0 || padRight > 0 || padBottom > 0 || padLeft > 0;

    const fontFamily = s.fontFamily
      ? s.fontFamily.split(',')[0].replace(/['"]/g, '').trim().replace(/^__([a-zA-Z0-9\\s-]+?)_[0-9a-f]{5,}$/i, '$1')
      : undefined;

    const children = [];
    if (tagName !== 'SVG') {
      for (const child of Array.from(el.children)) {
        const cTree = extractTree(child, depth + 1);
        if (cTree) children.push(cTree);
      }
    }

    const layout = inferLayout(el, s, rect, children);

    nodeCounter++;
    return {
      id: 'web-node-' + nodeCounter,
      tagName,
      role: el.getAttribute('role') || undefined,
      name: cap(el.getAttribute('aria-label') || el.id || el.className || tagName, 60),
      rect: {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      styles: {
        display: s.display,
        layoutMode: layout.layoutMode,
        flexWrap: layout.flexWrap,
        perRow: layout.perRow > 1 ? layout.perRow : undefined,
        maxWidth: layout.maxWidth,
        rowGap: px(s.rowGap) || undefined,
        columnGap: px(s.columnGap) || undefined,
        itemSpacing: px(s.columnGap) || px(s.rowGap) || undefined,
        padding: hasPadding ? { top: padTop, right: padRight, bottom: padBottom, left: padLeft } : undefined,
        backgroundColor: toHex(s.backgroundColor),
        color: toHex(s.color),
        borderRadius: borderRadius > 0 ? borderRadius : undefined,
        borderWidth: px(s.borderTopWidth) || undefined,
        borderColor: toHex(s.borderTopColor),
        boxShadow: s.boxShadow !== 'none' ? s.boxShadow : undefined,
        fontFamily,
        fontSize: px(s.fontSize) || undefined,
        fontWeight: s.fontWeight || undefined,
        lineHeight: px(s.lineHeight) || undefined,
        textAlign: s.textAlign || undefined,
      },
      text,
      direction: s.direction === 'rtl' ? 'rtl' : 'ltr',
      inlineSvg,
      imageUrl,
      children: children.length > 0 ? children : undefined,
    };
  };

  const rootElement = document.body || document.documentElement;
  const tree = extractTree(rootElement, 0);

  return {
    url: sanitizeUrl(window.location.href, true),
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      deviceScaleFactor: window.devicePixelRatio || 1,
    },
    variables,
    breakpoints,
    fonts,
    tree,
  };
})()`;

export const FIND_CONTROLS_SCRIPT = `(() => {
  for (const old of document.querySelectorAll('[data-figcp-state]')) {
    old.removeAttribute('data-figcp-state');
  }
  const cap = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const isShown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };

  const sel = '[aria-expanded="false"], [aria-haspopup]:not([aria-haspopup="false"]), [role="tab"][aria-selected="false"], details:not([open]) > summary';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= 10) break;
    if (!isShown(el) || el.closest('form') || el.matches('[type="submit"]')) continue;
    const pop = el.getAttribute('aria-haspopup');
    const kind = el.matches('summary') ? 'section' : el.getAttribute('role') === 'tab' ? 'tab' : pop === 'dialog' ? 'dialog' : 'menu';
    el.setAttribute('data-figcp-state', String(out.length));
    out.push({
      index: out.length,
      kind,
      label: cap(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || 'Control', 60),
    });
  }
  return out;
})()`;

export const STATE_CHECK_SCRIPT = (index: number) => `(() => {
  const el = document.querySelector('[data-figcp-state="${index}"]');
  const seen = (d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]')).filter(seen).length;
  const details = el && el.parentElement && el.parentElement.tagName === 'DETAILS' ? el.parentElement.open : null;
  return {
    present: !!el,
    expanded: el ? el.getAttribute('aria-expanded') : null,
    selected: el ? el.getAttribute('aria-selected') : null,
    open: details,
    dialogs,
    url: location.origin + location.pathname,
  };
})()`;

export const REMEMBER_TAB_SCRIPT = (index: number) => `(() => {
  const el = document.querySelector('[data-figcp-state="${index}"]');
  if (!el || el.getAttribute('role') !== 'tab') return false;
  const list = el.closest('[role="tablist"]') || el.parentElement;
  const was = list && Array.from(list.querySelectorAll('[role="tab"][aria-selected="true"]')).find((t) => t !== el);
  if (!was) return false;
  was.setAttribute('data-figcp-tab-was', '${index}');
  return true;
})()`;

export const RESELECT_TAB_SCRIPT = (index: number) => `(() => {
  const prev = document.querySelector('[data-figcp-tab-was="${index}"]');
  if (!prev) return false;
  prev.removeAttribute('data-figcp-tab-was');
  prev.click();
  return true;
})()`;

export const CLICK_CONTROL_SCRIPT = (index: number) => `(() => {
  const el = document.querySelector('[data-figcp-state="${index}"]');
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.click();
  return true;
})()`;
