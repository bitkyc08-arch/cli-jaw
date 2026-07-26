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

  // The ancestors that clip this element, innermost first.
  //
  // scrollable matters: auto/scroll means the user can bring the element into
  // view, so being outside is normal. hidden/clip means it can never be seen,
  // which is a defect rather than a reason to stop looking.
  function clippingAncestors(el) {
    const out = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      const y = s.overflowY, x = s.overflowX;
      const clips = /auto|scroll|hidden|clip/.test(y) || /auto|scroll|hidden|clip/.test(x);
      if (!clips) continue;
      const scrollable = /auto|scroll/.test(y) || /auto|scroll/.test(x);
      out.push({ el: n, scrollable });
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
    for (const { el: anc, scrollable } of clippingAncestors(el)) {
      const a = anc.getBoundingClientRect();
      if (r.bottom <= a.top || r.top >= a.bottom || r.right <= a.left || r.left >= a.right) {
        return { clipped: true, scrollable, by: String(anc.className ?? anc.tagName).slice(0, 40) };
      }
    }
    return { clipped: false, scrollable: false, by: null };
  }

  /**
   * A control the user can never reach, because an overflow:hidden ancestor
   * cuts it off entirely.
   *
   * Treating all clipping alike fixed the scroll-out false positives and
   * immediately hid a real defect: .d2-tool-copy is enabled, focusable and cut
   * off by .d2-tool-line's overflow:hidden, so dropping it as "invisible" made
   * the scan report a clean workbench.
   *
   * Deliberately collapsed UI is excluded: inert, aria-hidden and disabled all
   * say the author meant it.
   */
  function unreachableControl(el) {
    if (el.hasAttribute('disabled') || el.hasAttribute('inert')) return null;
    if (el.closest('[inert], [aria-hidden="true"]')) return null;
    // A hidden file input is the standard way to drive a styled upload button.
    // It is meant to be unreachable; the visible button is the real control.
    if (el.hasAttribute('hidden') || el.type === 'hidden') return null;
    if (el.tagName === 'INPUT' && el.type === 'file' && getComputedStyle(el).display === 'none') return null;
    // Inside a collapsed branch. display:none on an ancestor means the whole
    // subtree is deliberately not rendered -- the notes editor in its
    // non-compact layout, for instance -- which is a layout state, not a defect.
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden') return null;
    }
    const clip = clippedOut(el);
    if (!clip.clipped || clip.scrollable) return null;
    return { ...describe(el), clippedBy: clip.by };
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
    // Scrolled out of a scrollport is not rendered but is reachable, so it is
    // not measured here. Being cut off by overflow:hidden is a defect and is
    // reported separately by unreachableControl.
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


  /**
   * Can a single computed colour describe this element's glyphs?
   *
   * Not when the text is painted by a gradient clipped to the glyphs, or by a
   * blend mode, or by a filter. dashboard2 does this for real:
   * .d2-turn-shimmer paints its label with background-clip:text and
   * color:transparent, and reading its computed colour yields rgba(0,0,0,0) — which
   * scored a legible label 1:1.
   *
   * Returning a reason rather than a boolean so the scan can report WHY it
   * cannot judge, instead of guessing a pass or a fail.
   */
  function complexForeground(el) {
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      const clip = s.backgroundClip || s.webkitBackgroundClip;
      if (clip === 'text') return 'background-clip:text';
      if (s.mixBlendMode && s.mixBlendMode !== 'normal') return 'mix-blend-mode:' + s.mixBlendMode;
      if (s.filter && s.filter !== 'none') return 'filter:' + s.filter.slice(0, 24);

      // Group opacity: the browser renders the whole group and THEN fades it,
      // so glyph and backdrop are both composited toward whatever is behind.
      //
      //   F' = oF + (1-o)O      B' = oB + (1-o)O
      //
      // Sampling B' from the pixels while using F unfaded computes
      // contrast(F, B'), which is not the rendered pair.
      //
      // The first attempt only failed closed when the faded node painted its
      // OWN background, on the theory that a bare wrapper fades nothing but
      // text. That is wrong: a child, a background-image, or a pseudo-element
      // inside the group paints too, and an opacity:.5 wrapper around a white
      // child on black measured 2.63:1 where it renders 5.32:1 — a false
      // failure this time rather than a false pass.
      //
      // Resolving it needs the colour behind the entire group, which a paired
      // capture cannot supply. Any group opacity is unmeasurable.
      const o = Number(s.opacity);
      if (o < 1) {
        // A drag ghost is meant to be translucent: the card is deliberately
        // faded so the drop target shows through, and its contrast is judged in
        // the resting state it returns to. Marking every drag preview
        // unmeasurable would make the gate permanently red for a working
        // interaction. Anything else with opacity is still unmeasurable.
        const transient = n.matches('[data-dragging="true"], .is-dragging, [aria-grabbed="true"]');
        if (!transient) return 'group-opacity:' + o;
      }
    }
    return null;
  }

  /**
   * The colour the glyphs are actually painted with.
   *
   * The -webkit-text-fill-color property wins over color when both are set, so
   * a rule like color:black with -webkit-text-fill-color:#777 renders grey.
   * Reading the computed color there scored a 4.48:1 failure as 21:1.
   */
  function foregroundColour(el) {
    const s = getComputedStyle(el);
    const fill = s.webkitTextFillColor;
    if (fill && fill !== s.color) {
      const parsed = parseColour(fill);
      // A transparent fill with a visible color means something else paints
      // the glyphs; complexForeground catches that case and fails closed.
      if (parsed && parsed.a > 0) return parsed;
    }
    return parseColour(s.color);
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
    targetAudit, accessibleName, occlusion, clippedOut, clippingAncestors, complexForeground, foregroundColour,
    unreachableControl,
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


/**
 * Stop the page moving before taking a pair of screenshots.
 *
 * The two captures are compared pixel by pixel, so anything that changes
 * between them is read as glyph coverage: a shimmer, a spinner, a colour
 * transition, a blinking caret, a clock. Freezing first makes the difference
 * mean only what it is supposed to mean.
 */
export async function freezeMotion(page) {
    return page.addStyleTag({
        content: [
            '*, *::before, *::after {',
            '  animation-play-state: paused !important;',
            '  animation-duration: 0s !important;',
            '  animation-delay: 0s !important;',
            '  transition: none !important;',
            '  caret-color: transparent !important;',
            '}',
        ].join('\n'),
    });
}

/**
 * The alpha to composite a foreground with, given where its opacity is applied.
 *
 * Element opacity flattens the element AND its background together, so the
 * backdrop sampled from the rendered pixels ALREADY carries it. Multiplying the
 * glyph by that same opacity a second time double-counts it: the disabled send
 * button measured 2.7:1 where the rendered pair is 4.54:1.
 *
 * Only alpha that applies to the foreground alone — the colour's own alpha
 * channel, and opacity on ancestors that do not paint the sampled backdrop —
 * belongs in the composite.
 */
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

    // Two captures, not one.
    //
    // Classifying pixels into "glyph" and "backdrop" from a single image cannot
    // be done reliably, and a reviewer proved it with a counterexample: black
    // text over a half-white, half-#666 background scored 21:1, because the
    // grey lies on the RGB line between the text colour and white and my
    // antialiasing filter therefore discarded exactly the pixels that made it
    // fail. Any mid-grey backdrop sits on that line.
    //
    // So the glyphs are removed rather than guessed at. The second capture
    // makes text transparent, which leaves the backdrop untouched. Pixels that
    // differ between the two are glyph coverage, and the backdrop is read from
    // the SAME coordinates in the text-free image.
    // Snapshot the foreground BEFORE touching the page.
    //
    // Reading `color` after removing the hide/freeze styles measures whatever
    // the colour transition happens to be passing through on its way back:
    // notes text read as rgba(146,146,155,0.557) mid-transition and scored
    // 1.21:1 while the settled value passes comfortably. The oracle was
    // causing the very change it then measured.
    //
    // The snapshot also flattens alpha and every ancestor opacity, because
    // `color: #000` at `opacity: .1` renders as light grey no matter what the
    // computed colour says. Without this, black-at-10%-opacity scored 21:1.
    await installMeasure(page);
    const foregrounds = await page.evaluate((sel) => {
        const m = window.__d2measure;
        const root = document.querySelector(sel);
        return m.textNodes()
            .filter((el) => !root || root.contains(el))
            .map((el, index) => {
                el.setAttribute('data-d2-fg', String(index));
                const style = getComputedStyle(el);
                const complex = m.complexForeground(el);
                const colour = m.foregroundColour(el);
                // Opacity is only already in the backdrop when the element that
                // carries it also PAINTS that backdrop. A translucent button
                // with its own fill dims glyph and fill together, so folding it
                // in again double-counts (the disabled send button read 2.7:1
                // where the rendered pair is 4.54:1). A translucent wrapper over
                // an opaque page dims only the text, so it must be folded in
                // (black at 10% opacity renders pale grey, not black).
                let alpha = colour.a ?? 1;
                for (let n = el; n; n = n.parentElement) {
                    const os = getComputedStyle(n);
                    const o = Number(os.opacity);
                    if (o === 1) continue;
                    const own = m.parseColour(os.backgroundColor);
                    const paintsBackdrop = Boolean(own && own.a > 0);
                    if (!paintsBackdrop) alpha *= o;
                }
                const r = el.getBoundingClientRect();
                return {
                    index,
                    colour,
                    alpha,
                    complex,
                    need: m.requiredContrast(style),
                    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                    describe: m.describe(el),
                };
            });
    }, selectorScope);

    const freeze = await freezeMotion(page);
    let shot;
    let bare;
    let hideText;
    try {
        shot = await page.screenshot({ clip });
        // Only the foreground is removed. `color` alone is not enough: a
        // -webkit-text-fill-color or a text-shadow would keep painting.
        hideText = await page.addStyleTag({
            content: '*, *::before, *::after { color: transparent !important; text-shadow: none !important; -webkit-text-fill-color: transparent !important; }',
        });
        bare = await page.screenshot({ clip });
    } finally {
        // Order matters. Removing the hide style first, while motion is still
        // frozen, means the colour snaps back instead of animating: an unfrozen
        // restore leaves a transition running that the NEXT measurement then
        // samples mid-flight. Unfreeze last, after a beat for the paint.
        await hideText?.evaluate((node) => node.remove()).catch(() => {});
        await page.waitForTimeout(80);
        await freeze.evaluate((node) => node.remove()).catch(() => {});
    }

    return page.evaluate(async ({ data, bareData, origin, snapshots }) => {
        const m = window.__d2measure;
        const decode = async (b64) => {
            const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
            const bitmap = await createImageBitmap(blob);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const c = canvas.getContext('2d');
            c.drawImage(bitmap, 0, 0);
            return { bitmap, ctx: c };
        };
        const { bitmap, ctx } = await decode(data);
        const { ctx: bareCtx } = await decode(bareData);

        const dpr = bitmap.width / origin.width;
        const results = [];

        for (const snap of snapshots) {
            // Fail closed, loudly. Guessing a pass would hide a real problem and
            // guessing a fail would send someone to "fix" working code; both are
            // worse than saying the oracle cannot judge this shape.
            if (snap.complex) {
                results.push({
                    ...snap.describe,
                    ratio: null,
                    need: snap.need,
                    backdrop: null,
                    unmeasurable: snap.complex,
                    pass: false,
                });
                continue;
            }
            const r = snap.rect;
            // No inset. Trimming a pixel was meant to avoid a pill's own border
            // bleeding in, but on a 13px-tall label it clips the tops of the
            // glyphs and leaves only their antialiased skirts, which read as a
            // mid-grey "backdrop" and scored 15:1 body text at 4.37:1. The
            // paired capture already solves the border problem: whatever the
            // border is, it is identical in both images and so is never counted
            // as glyph coverage.
            const sx = Math.round((r.x - origin.x) * dpr);
            const sy = Math.round((r.y - origin.y) * dpr);
            const sw = Math.round(r.width * dpr);
            const sh = Math.round(r.height * dpr);
            if (sx < 0 || sy < 0 || sw < 2 || sh < 2 || sx + sw > bitmap.width || sy + sh > bitmap.height) continue;

            const { data: px } = ctx.getImageData(sx, sy, sw, sh);
            const { data: bx } = bareCtx.getImageData(sx, sy, sw, sh);
            const need = snap.need;
            const rawFg = snap.colour;

            // Backdrop colours beneath glyph coverage, sampled from the
            // text-free capture so a mid-grey band cannot be mistaken for an
            // antialiasing artefact.
            // Delta of 1, not 20. Text that is nearly the same colour as its
            // background barely moves the pixels when it is hidden, so a
            // generous threshold discards exactly the worst case: #777 on
            // #787878 produced no row at all, and an element with no row is an
            // element that silently passes.
            const counts = new Map();
            const bareCounts = new Map();
            let covered = 0;
            const totalPixels = px.length / 4;
            for (let i = 0; i < px.length; i += 4) {
                const key = bx[i] + ',' + bx[i + 1] + ',' + bx[i + 2];
                bareCounts.set(key, (bareCounts.get(key) ?? 0) + 1);
                const diff = Math.abs(px[i] - bx[i]) + Math.abs(px[i + 1] - bx[i + 1]) + Math.abs(px[i + 2] - bx[i + 2]);
                if (diff < 2) continue;
                covered += 1;
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            const backdropShare = new Map(
                [...bareCounts.entries()].map(([k, n]) => [k, n / totalPixels]),
            );

            // No detectable coverage does not mean "fine". Either the text is
            // invisible against its background or the capture failed; both need
            // a row so the scan can fail rather than fall silent.
            if (covered === 0) {
                const bg = { r: bx[0], g: bx[1], b: bx[2], a: 1 };
                const ratio = m.contrast(m.composite({ ...rawFg, a: snap.alpha }, bg), bg);
                results.push({
                    ...snap.describe,
                    ratio: Number(ratio.toFixed(2)),
                    need,
                    backdrop: bg,
                    glyphPixels: 0,
                    indistinguishable: true,
                    pass: false,
                });
                continue;
            }

            let worst = Infinity;
            let worstColour = null;
            for (const [key, n] of counts) {
                // Small text is mostly edge pixels: at 11px a path label is
                // hundreds of partly covered samples whose backdrop reads
                // lighter than the real one, and taking the single worst scored
                // 15:1 body text as 4.37:1.
                //
                // A share threshold alone is the wrong fix — a genuinely dark
                // 6%-wide band would be excused by it. Exclude a colour only
                // when it is BOTH rare and a blend between the foreground and a
                // more common backdrop, which is what an antialiased edge is
                // No share-based exemption. Every colour here comes from the
                // TEXT-FREE capture, so it is by construction a real backdrop
                // pixel and not an antialiasing artefact -- the artefacts live
                // in the other image. A 1%-wide dark stripe is as real as a
                // 40%-wide one, and filtering by share let a genuine 2.16:1
                // failure through at 21:1.
                //
                // The small-text problem this once tried to solve is handled by
                // sampling the whole element box instead of an inset one, so the
                // glyph tops are no longer clipped away.
                const parts = key.split(',').map(Number);
                const candidate = { r: parts[0], g: parts[1], b: parts[2], a: 1 };
                // Flatten the foreground onto THIS backdrop: a translucent glyph
                // is only as dark as what shows through it.
                const effective = m.composite({ ...rawFg, a: snap.alpha }, candidate);
                const ratio = m.contrast(effective, candidate);
                if (ratio < worst) { worst = ratio; worstColour = candidate; }
            }
            if (!Number.isFinite(worst)) continue;

            results.push({
                ...snap.describe,
                ratio: Number(worst.toFixed(2)),
                need,
                backdrop: worstColour,
                glyphPixels: covered,
                pass: worst >= need,
            });
        }
        return results;
    }, { data: shot.toString('base64'), bareData: bare.toString('base64'), origin: clip, snapshots: foregrounds });
}
/**
 * Icon contrast from rendered pixels, using the same paired-capture trick.
 *
 * Icons were still measured through the CSSOM after text moved to pixels, so
 * "the whole scan reads pixels" was only true of half of it. An SVG stroke is
 * drawn with `currentColor`, so hiding it the way text is hidden needs a
 * different lever: stroke and fill are forced transparent instead.
 */
export async function surfaceIconContrast(page, selectorScope, minRatio = 3) {
    const box = await page.locator(selectorScope).boundingBox();
    if (!box) return null;
    const clip = {
        x: Math.max(0, Math.round(box.x)),
        y: Math.max(0, Math.round(box.y)),
        width: Math.max(1, Math.round(box.width)),
        height: Math.max(1, Math.round(box.height)),
    };
    // Same lifecycle rule as text: snapshot the foreground before mutating the
    // page, and flatten alpha plus every ancestor opacity into it.
    await installMeasure(page);
    const foregrounds = await page.evaluate((sel) => {
        const m = window.__d2measure;
        const root = document.querySelector(sel);
        return m.controls()
            .filter((el) => (!root || root.contains(el)) && !el.textContent?.trim() && el.querySelector('svg'))
            .map((el) => {
                const style = getComputedStyle(el);
                const colour = m.foregroundColour(el);
                const complex = m.complexForeground(el);
                // Same rule as text: see the note above surfacePixelContrast.
                let alpha = colour.a ?? 1;
                for (let n = el; n; n = n.parentElement) {
                    const os = getComputedStyle(n);
                    const o = Number(os.opacity);
                    if (o === 1) continue;
                    const own = m.parseColour(os.backgroundColor);
                    if (!(own && own.a > 0)) alpha *= o;
                }
                const r = el.getBoundingClientRect();
                return { colour, alpha, complex, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, describe: m.describe(el) };
            });
    }, selectorScope);

    const freeze = await freezeMotion(page);
    let shot;
    let bare;
    let hideIcons;
    try {
        shot = await page.screenshot({ clip });
        hideIcons = await page.addStyleTag({
            content: 'svg, svg * { stroke: transparent !important; fill: transparent !important; }',
        });
        bare = await page.screenshot({ clip });
    } finally {
        // Same ordering rule as the text pass: unhide under the freeze so the
        // colour snaps rather than animates.
        await hideIcons?.evaluate((node) => node.remove()).catch(() => {});
        await page.waitForTimeout(80);
        await freeze.evaluate((node) => node.remove()).catch(() => {});
    }

    return page.evaluate(async ({ data, bareData, origin, threshold, snapshots }) => {
        const m = window.__d2measure;
        const decode = async (b64) => {
            const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
            const bitmap = await createImageBitmap(blob);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const c = canvas.getContext('2d');
            c.drawImage(bitmap, 0, 0);
            return { bitmap, ctx: c };
        };
        const { bitmap, ctx } = await decode(data);
        const { ctx: bareCtx } = await decode(bareData);

        const dpr = bitmap.width / origin.width;
        const results = [];

        for (const snap of snapshots) {
            if (snap.complex) {
                results.push({
                    ...snap.describe,
                    ratio: null,
                    need: threshold,
                    backdrop: null,
                    unmeasurable: snap.complex,
                    pass: false,
                });
                continue;
            }
            const r = snap.rect;
            const sx = Math.round((r.x - origin.x) * dpr);
            const sy = Math.round((r.y - origin.y) * dpr);
            const sw = Math.round(r.width * dpr);
            const sh = Math.round(r.height * dpr);
            if (sx < 0 || sy < 0 || sw < 2 || sh < 2 || sx + sw > bitmap.width || sy + sh > bitmap.height) continue;

            const { data: px } = ctx.getImageData(sx, sy, sw, sh);
            const { data: bx } = bareCtx.getImageData(sx, sy, sw, sh);
            const rawFg = snap.colour;

            const counts = new Map();
            let covered = 0;
            for (let i = 0; i < px.length; i += 4) {
                const diff = Math.abs(px[i] - bx[i]) + Math.abs(px[i + 1] - bx[i + 1]) + Math.abs(px[i + 2] - bx[i + 2]);
                if (diff < 2) continue;
                covered += 1;
                const key = bx[i] + ',' + bx[i + 1] + ',' + bx[i + 2];
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }

            // An icon indistinguishable from its backdrop is the worst outcome,
            // so it must produce a failing row rather than disappear.
            if (covered === 0) {
                const bg = { r: bx[0], g: bx[1], b: bx[2], a: 1 };
                results.push({
                    ...snap.describe,
                    ratio: Number(m.contrast(m.composite({ ...rawFg, a: snap.alpha }, bg), bg).toFixed(2)),
                    need: threshold,
                    backdrop: bg,
                    iconPixels: 0,
                    indistinguishable: true,
                    pass: false,
                });
                continue;
            }

            let worst = Infinity;
            let worstColour = null;
            for (const [key, n] of counts) {
                // No share exemption here either. This is the same logic the text
                // path already dropped, and it survived one round too long: a
                // black icon crossing a 2%-wide #444 stripe measured 21:1 where
                // the real worst pair is 2.16:1.
                //
                // The edge-pixel problem it was meant to solve does not exist in
                // this loop: every candidate comes from the icon-free capture,
                // so it is a real backdrop colour by construction.
                const parts = key.split(',').map(Number);
                const candidate = { r: parts[0], g: parts[1], b: parts[2], a: 1 };
                // Flatten the foreground onto THIS backdrop: a translucent glyph
                // is only as dark as what shows through it.
                const effective = m.composite({ ...rawFg, a: snap.alpha }, candidate);
                const ratio = m.contrast(effective, candidate);
                if (ratio < worst) { worst = ratio; worstColour = candidate; }
            }
            if (!Number.isFinite(worst)) continue;

            results.push({
                ...snap.describe,
                ratio: Number(worst.toFixed(2)),
                need: threshold,
                backdrop: worstColour,
                iconPixels: covered,
                pass: worst >= threshold,
            });
        }
        return results;
    }, { data: shot.toString('base64'), bareData: bare.toString('base64'), origin: clip, threshold: minRatio, snapshots: foregrounds });
}
