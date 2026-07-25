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
    return true;
  }

  /**
   * Is this element actually the thing painted at its own centre?
   *
   * Separate from isVisible because being covered is a defect worth reporting,
   * not a reason to skip the element. .d2-tool-copy is laid out, opaque, and
   * completely hidden behind .d2-segment-toggle.
   */
  function occlusion(el) {
    const r = el.getBoundingClientRect();
    const x = Math.min(innerWidth - 1, Math.max(0, r.x + r.width / 2));
    const y = Math.min(innerHeight - 1, Math.max(0, r.y + r.height / 2));
    const top = document.elementFromPoint(x, y);
    if (!top) return { covered: true, by: null };
    if (top === el || el.contains(top) || top.contains(el)) return { covered: false, by: null };
    return { covered: true, by: String(top.className ?? top.tagName).slice(0, 44) };
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
    const big = r.width >= 24 && r.height >= 24;
    if (big) return { ok: true, reason: 'meets-24' };

    // Inline links inside a sentence are exempt.
    if (el.tagName === 'A' && el.closest('p, li, span, td')) return { ok: true, reason: 'inline-exception' };

    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    let nearest = Infinity;
    let nearestOf = null;
    for (const other of all) {
      if (other === el) continue;
      const o = other.getBoundingClientRect();
      if (o.width < 1 || o.height < 1) continue;
      const d = Math.hypot(cx - (o.x + o.width / 2), cy - (o.y + o.height / 2));
      if (d < nearest) { nearest = d; nearestOf = other; }
    }
    // Two 24px circles overlap when their centres are closer than 24px.
    const spaced = nearest >= 24;
    return {
      ok: spaced,
      reason: spaced ? 'spacing-exception' : 'undersized-and-crowded',
      width: Math.round(r.width),
      height: Math.round(r.height),
      nearestCentre: Number.isFinite(nearest) ? Math.round(nearest) : null,
      nearestCls: nearestOf ? String(nearestOf.className ?? '').slice(0, 40) : null,
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
    targetAudit, accessibleName, occlusion,
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
