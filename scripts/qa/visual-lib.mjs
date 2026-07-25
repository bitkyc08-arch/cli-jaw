// Colour and geometry primitives for the visual gates.
//
// These live apart from qa-lib because they are pure functions that also need
// to run inside page.evaluate, where imports are not available. Each gate
// injects MEASURE_SOURCE into the page rather than importing it.
//
// The reason this file exists at all: the first contrast probe I wrote reported
// two AA failures in the light theme. Both were wrong. It parsed colours with
// /[\d.]+/g, which silently mangles Chrome's `color(srgb 0.09 0.12 0.16 / 0.08)`
// into 0.09/0.12/0.16 read as 0-255 RGB — i.e. near-black. A screenshot of the
// actual pixels showed 4.93:1, comfortably passing. A measuring tool that
// reports phantom failures is worse than none: it sends you off to "fix"
// working code.

/** Source text injected into the page. Keep it self-contained. */
export const MEASURE_SOURCE = String.raw`
(() => {
  // Parse any CSS colour Chrome can emit: rgb(), rgba(), and color(srgb r g b / a)
  // whose channels are 0-1 floats rather than 0-255 integers.
  function parseColour(input) {
    if (!input || input === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const srgb = input.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
    if (srgb) {
      return {
        r: Number(srgb[1]) * 255,
        g: Number(srgb[2]) * 255,
        b: Number(srgb[3]) * 255,
        a: srgb[4] === undefined ? 1 : Number(srgb[4]),
      };
    }
    const rgb = input.match(/rgba?\(([^)]+)\)/);
    if (rgb) {
      const parts = rgb[1].split(/[,\s\/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
    }
    return null;
  }

  function composite(fg, bg) {
    const a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }

  function luminance(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  function contrast(fg, bg) {
    const a = luminance(fg), b = luminance(bg);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  // The colour behind an element according to the CSSOM.
  //
  // Flattens translucent layers rather than stopping at the first opaque-ish
  // ancestor, because the mode switcher is a 4% tint inside a themed panel.
  //
  // KNOWN LIMIT: this cannot see ::before/::after. The sidebar paints its glass
  // effect on .d2-sidebar-v4::before, so every contrast reading inside the
  // sidebar is off by that layer. Use backgroundAtPoint for anything that must
  // be exact; this remains useful for elements with ordinary backgrounds.
  function effectiveBackground(el) {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parseColour(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a === 1) break; }
      // A pseudo-element can paint a full-bleed layer the CSSOM background
      // walk never sees. The sidebar's glass gradient is exactly this, and it
      // shifted every contrast reading inside the sidebar by ~0.2.
      const before = getComputedStyle(n, '::before');
      if (before && before.content !== 'none' && before.position === 'absolute') {
        const grad = before.backgroundImage;
        const first = grad && grad !== 'none' ? grad.match(/rgba?\([^)]+\)|color\(srgb[^)]+\)/) : null;
        if (first) {
          const c2 = parseColour(first[0]);
          if (c2 && c2.a > 0) { layers.push(c2); if (c2.a === 1) break; }
        }
      }
    }
    let base = layers.length && layers[layers.length - 1].a === 1
      ? layers.pop()
      : { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i -= 1) base = composite(layers[i], base);
    return base;
  }

  // WCAG 2.1: 3:1 for large text (>=24px, or >=18.66px bold), else 4.5:1.
  function requiredContrast(style) {
    const size = parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || 400;
    return (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5;
  }

  // The scrollports that clip this element, innermost first.
  function clippingAncestors(el) {
    const out = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/auto|scroll|hidden|clip/.test(s.overflowY) || /auto|scroll|hidden|clip/.test(s.overflowX)) out.push(n);
    }
    return out;
  }

  // Is the element scrolled out of one of its own scrollports?
  //
  // This is the check that turned two "defects" into nothing. 37 of the 50
  // instance controls sit below the sidebar list's scrollport: they have real
  // coordinates, so a naive reading treats them as on-screen, and their
  // neighbours compute as impossibly close together. Scrolled into view they
  // are 60px apart and perfectly legal.
  function clippedOut(el) {
    const r = el.getBoundingClientRect();
    for (const anc of clippingAncestors(el)) {
      const a = anc.getBoundingClientRect();
      if (r.bottom <= a.top || r.top >= a.bottom || r.right <= a.left || r.left >= a.right) {
        return { clipped: true, by: String(anc.className ?? anc.tagName).slice(0, 40) };
      }
    }
    return { clipped: false, by: null };
  }

  // Visible means visible to a user, which is stricter than a non-zero box.
  //
  // Checking only the element's own opacity missed the tool-copy button: it is
  // fully opaque itself but sits underneath a sibling that covers it, so it
  // renders nowhere and cannot be clicked. An audit that counts it as visible
  // then measures its contrast against the wrong backdrop.
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    if (/(^|\s)(d2-)?sr-only(\s|$)/.test(String(el.className))) return false;
    // Any ancestor can zero out this element's opacity.
    for (let n = el; n; n = n.parentElement) {
      const os = getComputedStyle(n);
      if (Number(os.opacity) === 0 || os.visibility === 'hidden' || os.display === 'none') return false;
    }
    // Outside the viewport is not rendered.
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    // Scrolled out of an ancestor scrollport is equally not rendered.
    if (clippedOut(el).clipped) return false;
    return true;
  }

  /**
   * Is this element actually the thing painted at its own centre?
   *
   * Separate from isVisible because being covered is a defect worth reporting,
   * not a reason to skip the element. .d2-tool-copy is laid out, opaque, and
   * completely hidden behind .d2-segment-toggle.
   */
  // Sampled at several points, because a control covered at its centre may still
  // be operable at a corner, and one covered everywhere is a real defect.
  //
  // top.contains(el) is deliberately NOT treated as "not covered": an ancestor
  // being the hit target means the child is behind its own parent's painted
  // content, which is exactly the tool-copy case.
  function occlusion(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { covered: true, by: null, hits: 0 };
    const inset = Math.min(3, r.width / 4, r.height / 4);
    const points = [
      [r.x + r.width / 2, r.y + r.height / 2],
      [r.x + inset, r.y + inset],
      [r.x + r.width - inset, r.y + inset],
      [r.x + inset, r.y + r.height - inset],
      [r.x + r.width - inset, r.y + r.height - inset],
    ];
    let reachable = 0;
    let coveredBy = null;
    for (const [px, py] of points) {
      if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) continue;
      const top = document.elementFromPoint(px, py);
      if (!top) continue;
      if (top === el || el.contains(top)) reachable += 1;
      else if (!coveredBy) coveredBy = String(top.className ?? top.tagName).slice(0, 44);
    }
    return { covered: reachable === 0, by: coveredBy, hits: reachable };
  }

  // Elements whose own text is rendered, not wrappers that merely contain it.
  function textNodes() {
    return [...document.querySelectorAll('*')].filter((el) =>
      isVisible(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
  }

  function controls() {
    const role = (el) => el.getAttribute('role') ?? '';
    return [...document.querySelectorAll('*')].filter((el) =>
      isVisible(el)
      && (/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)
        || ['button', 'tab', 'menuitem', 'menuitemcheckbox', 'switch', 'option', 'link'].includes(role(el))));
  }

  function describe(el) {
    return {
      tag: el.tagName,
      cls: String(el.className ?? '').slice(0, 52),
      label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 32),
    };
  }

  // WCAG 2.2 AA 2.5.8 Target Size (Minimum) with its exceptions.
  //
  // A 22x22 control is NOT automatically a violation. The Spacing exception
  // allows an undersized target when a 24px-diameter circle centred on it
  // touches no other target's circle — which is why the instance controls, at
  // 22px with 2px gaps, sit exactly on the boundary. Reporting them as certain
  // violations without this check would be wrong.
  function targetAudit(el, all) {
    const r = el.getBoundingClientRect();
    if (r.width >= 24 && r.height >= 24) return { ok: true, reason: 'meets-24' };

    // The inline exception covers a link in a run of text, not any link that
    // happens to sit in a list item. Require actual sibling text around it.
    if (el.tagName === 'A') {
      const parent = el.parentElement;
      const siblingText = parent
        ? [...parent.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
        : false;
      if (siblingText) return { ok: true, reason: 'inline-exception' };
    }

    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;

    // 2.5.8 Spacing: a 24px circle centred on this target must not intersect
    // another target's circle (if that one is also undersized) or its actual
    // area (if it is large enough). Comparing centre distances alone lets a
    // wide neighbouring button pass while its edge sits under our circle.
    let worst = null;
    for (const other of all) {
      if (other === el) continue;
      const o = other.getBoundingClientRect();
      if (o.width < 1 || o.height < 1) continue;
      const otherBig = o.width >= 24 && o.height >= 24;

      let clash = false;
      let metric;
      if (otherBig) {
        // Circle (radius 12 around cx,cy) vs rectangle.
        const nx = Math.max(o.left, Math.min(cx, o.right));
        const ny = Math.max(o.top, Math.min(cy, o.bottom));
        const d = Math.hypot(cx - nx, cy - ny);
        clash = d < 12;
        metric = { kind: 'circle-vs-rect', distance: Math.round(d) };
      } else {
        const d = Math.hypot(cx - (o.x + o.width / 2), cy - (o.y + o.height / 2));
        clash = d < 24;
        metric = { kind: 'circle-vs-circle', distance: Math.round(d) };
      }
      if (clash && (!worst || metric.distance < worst.metric.distance)) {
        worst = { other, metric };
      }
    }

    return {
      ok: !worst,
      reason: worst ? 'undersized-and-crowded' : 'spacing-exception',
      width: Math.round(r.width),
      height: Math.round(r.height),
      ...(worst
        ? { conflict: worst.metric, conflictCls: String(worst.other.className ?? '').slice(0, 40) }
        : {}),
    };
  }

  // The accessible name as the platform computes it, not a guess.
  //
  // Checking aria-label/title/textContent alone reported two settings
  // checkboxes as unnamed; both are wrapped in a <label>, so they do have
  // names. Follow the parts of the accname algorithm that actually apply here.
  function accessibleName(el) {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
        .join(' ').trim();
      if (text) return text;
    }
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim();
    if (el.id) {
      const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (forLabel?.textContent?.trim()) return forLabel.textContent.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
    if (el.tagName === 'INPUT') {
      const v = el.getAttribute('value') ?? el.getAttribute('placeholder');
      if (v?.trim()) return v.trim();
    }
    const title = el.getAttribute('title');
    if (title?.trim()) return title.trim();
    const own = el.textContent?.trim();
    if (own) return own;
    // An icon-only control may name itself through the svg's title.
    const svgTitle = el.querySelector('svg title')?.textContent?.trim();
    return svgTitle ?? '';
  }

  window.__d2measure = {
    parseColour, composite, luminance, contrast, effectiveBackground,
    requiredContrast, isVisible, textNodes, controls, describe,
    targetAudit, accessibleName, occlusion, clippedOut, clippingAncestors,
  };
})();
`;

/**
 * Read the ACTUAL rendered pixels inside an element.
 *
 * An earlier version of this returned a PNG buffer and never decoded it, while
 * the self-test compared CSSOM output against a hard-coded 4.93 — so nothing
 * verified anything. Decoding PNG in Node would mean a new dependency; instead
 * Chrome decodes its own screenshot through createImageBitmap and hands back a
 * histogram. That is the same pixels the user sees, with no parser of mine in
 * between.
 *
 * Returns { modal, samples, histogram } where `modal` is the most common colour
 * — the backdrop for any region that is mostly background.
 */
export async function pixelHistogram(page, box, inset = 3) {
    const clip = {
        x: Math.round(box.x + inset),
        y: Math.round(box.y + inset),
        width: Math.max(1, Math.round(box.width - inset * 2)),
        height: Math.max(1, Math.round(box.height - inset * 2)),
    };
    const shot = await page.screenshot({ clip });
    const base64 = shot.toString('base64');

    return page.evaluate(async (data) => {
        const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const { data: px } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

        const counts = new Map();
        for (let i = 0; i < px.length; i += 4) {
            const key = `${px[i]},${px[i + 1]},${px[i + 2]}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const toRgb = (k) => { const [r, g, b] = k.split(',').map(Number); return { r, g, b, a: 1 }; };
        return {
            samples: px.length / 4,
            modal: toRgb(sorted[0][0]),
            histogram: sorted.slice(0, 8).map(([k, n]) => ({ colour: toRgb(k), count: n })),
        };
    }, base64);
}

/**
 * Contrast measured from rendered pixels rather than from the CSSOM.
 *
 * The text colour still comes from computed style (it is exact), but the
 * backdrop is the modal pixel of the element's own box. This sees pseudo-element
 * layers, gradients, backdrop-filter and images — all of which are invisible to
 * a backgroundColor walk.
 */
export async function pixelContrast(page, locator) {
    const box = await locator.boundingBox();
    if (!box || box.width < 8 || box.height < 8) return null;
    const [{ modal }, colour] = await Promise.all([
        pixelHistogram(page, box),
        locator.evaluate((el) => getComputedStyle(el).color),
    ]);
    return page.evaluate(({ modal: bg, colour: fg }) => {
        const m = window.__d2measure;
        return Number(m.contrast(m.parseColour(fg), bg).toFixed(3));
    }, { modal, colour });
}

/** Install the measurement helpers into a page. */
export async function installMeasure(page) {
    await page.evaluate(MEASURE_SOURCE);
}

/** Every visual gate runs against both themes. */
export const THEMES = ['dark', 'light'];

export async function setTheme(page, theme) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(350);
}
/**
 * Contrast for many elements at once, read from one screenshot.
 *
 * `pixelContrast` takes a screenshot per element, which is far too slow for a
 * full-surface sweep. This captures the surface once, then samples each text
 * element's own box out of that single bitmap inside the page.
 *
 * For each element it reports the WORST contrast across the sampled backdrop
 * colours rather than the most common one, so a small dark band under a line of
 * text cannot hide behind a large light majority.
 */
export async function surfacePixelContrast(page, selectorScope) {
    const box = await page.locator(selectorScope).boundingBox();
    if (!box) return null;
    const clip = {
        x: Math.max(0, Math.round(box.x)),
        y: Math.max(0, Math.round(box.y)),
        width: Math.max(1, Math.round(box.width)),
        height: Math.max(1, Math.round(box.height)),
    };
    const shot = await page.screenshot({ clip });
    return page.evaluate(async ({ data, origin, scope }) => {
        const m = window.__d2measure;
        const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);

        const root = document.querySelector(scope);
        const dpr = bitmap.width / origin.width;
        const results = [];

        for (const el of m.textNodes()) {
            if (root && !root.contains(el)) continue;
            const r = el.getBoundingClientRect();
            // Inset by a pixel: a bounding rect includes the element's own edge,
            // and on a small pill the strip of parent background just outside
            // the fill was 12% of the box — enough to be picked as "backdrop"
            // and report 1.5:1 for white-on-blue that is really 4.84:1.
            const pad = Math.max(1, Math.round(1 * dpr));
            const sx = Math.round((r.x - origin.x) * dpr) + pad;
            const sy = Math.round((r.y - origin.y) * dpr) + pad;
            const sw = Math.round(r.width * dpr) - pad * 2;
            const sh = Math.round(r.height * dpr) - pad * 2;
            if (sx < 0 || sy < 0 || sw < 2 || sh < 2 || sx + sw > bitmap.width || sy + sh > bitmap.height) continue;

            const { data: px } = ctx.getImageData(sx, sy, sw, sh);
            const counts = new Map();
            for (let i = 0; i < px.length; i += 4) {
                const key = `${px[i]},${px[i + 1]},${px[i + 2]}`;
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            const total = px.length / 4;
            const style = getComputedStyle(el);
            const fg = m.parseColour(style.color);
            const need = m.requiredContrast(style);

            // Choosing the worst colour above a small share sounded safe and was
            // not: on a 15px badge the antialiased edge between white glyphs and
            // a blue field is several percent of the box, and reading that blend
            // as "the background" reported 1.5:1 where the real pair is 4.84:1.
            //
            // So candidates must be BACKGROUND, which means two things: a
            // meaningful share of the box, and not on the line between the text
            // colour and another candidate. Antialiased pixels are exactly the
            // colours that sit between two others, so they are excluded by
            // construction rather than by a magic threshold.
            const entries = [...counts.entries()]
                .map(([key, n]) => {
                    const [cr, cg, cb] = key.split(',').map(Number);
                    return { colour: { r: cr, g: cg, b: cb, a: 1 }, share: n / total };
                })
                .filter((e) => e.share >= 0.08)
                .sort((a, b) => b.share - a.share);

            const isBlendOfTextAnd = (candidate, other) => {
                // A pixel produced by blending `fg` with `other` lies on the
                // segment between them. Allow a small tolerance for rounding.
                const dx = other.r - fg.r, dy = other.g - fg.g, dz = other.b - fg.b;
                const len2 = dx * dx + dy * dy + dz * dz;
                if (len2 < 1) return false;
                const t = ((candidate.r - fg.r) * dx + (candidate.g - fg.g) * dy + (candidate.b - fg.b) * dz) / len2;
                if (t <= 0.02 || t >= 0.98) return false;
                const px = fg.r + dx * t, py = fg.g + dy * t, pz = fg.b + dz * t;
                return Math.hypot(candidate.r - px, candidate.g - py, candidate.b - pz) < 12;
            };

            let worst = Infinity;
            let worstColour = null;
            for (const entry of entries) {
                const c = entry.colour;
                // The glyph colour itself is not a backdrop.
                if (Math.abs(c.r - fg.r) + Math.abs(c.g - fg.g) + Math.abs(c.b - fg.b) < 24) continue;
                // Nor is an edge pixel between the glyph and a larger field.
                if (entries.some((o) => o !== entry && o.share > entry.share && isBlendOfTextAnd(c, o.colour))) continue;
                const ratio = m.contrast(fg, c);
                if (ratio < worst) { worst = ratio; worstColour = c; }
            }
            if (!Number.isFinite(worst)) continue;
            results.push({
                ...m.describe(el),
                ratio: Number(worst.toFixed(2)),
                need,
                backdrop: worstColour,
                pass: worst >= need,
            });
        }
        return results;
    }, { data: shot.toString('base64'), origin: clip, scope: selectorScope });
}
