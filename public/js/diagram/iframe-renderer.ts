// ── Sandboxed iframe renderer for diagram-html widgets ──
// Phase 2: Inflates diagram-html placeholders into sandbox="allow-scripts" iframes
// with validated postMessage bridge for theme sync, resize, and sendPrompt.

import { ICONS } from '../icons.js';
import { validateWidgetHtml } from './widget-validator.js';

// ── Action Button Helpers ──
function createDiagramCopyBtn(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'diagram-copy-btn';
  btn.type = 'button';
  btn.ariaLabel = 'Copy source';
  btn.title = 'Copy';
  btn.innerHTML = ICONS.copy;
  return btn;
}

function createDiagramSaveBtn(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'diagram-save-btn';
  btn.type = 'button';
  btn.ariaLabel = 'Save as image';
  btn.title = 'Save';
  btn.innerHTML = ICONS.download;
  return btn;
}

function createDiagramZoomBtn(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'diagram-zoom-btn';
  btn.type = 'button';
  btn.ariaLabel = 'Expand diagram';
  btn.title = 'Expand';
  btn.textContent = '⤢';
  return btn;
}

function createDiagramSizeToggleBtn(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'diagram-size-toggle-btn';
  btn.type = 'button';
  btn.ariaLabel = 'Expand diagram';
  btn.title = 'Expand';
  btn.textContent = '⤢';
  return btn;
}

// ── CDN Allowlist (Phase 5 libraries) ──
const CDN_ALLOWLIST = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'esm.sh',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// ── Registered iframes for postMessage validation ──
const registeredIframes = new Set<Window>();

// ── Per-iframe nonces for navigation defense ──
const iframeNonces = new Map<Window, string>();

const widgetLifecycleCleanups = new WeakMap<HTMLElement, () => void>();

function cleanupWidgetOwner(owner: HTMLElement): void {
  const cleanup = widgetLifecycleCleanups.get(owner);
  if (!cleanup) return;
  cleanup();
  widgetLifecycleCleanups.delete(owner);
}

function revokeIframeTrust(iframe: HTMLIFrameElement): void {
  if (!iframe.contentWindow) return;
  registeredIframes.delete(iframe.contentWindow);
  iframeNonces.delete(iframe.contentWindow);
}

function attachWidgetIframeLifecycle(input: {
  iframe: HTMLIFrameElement;
  nonce: string;
  owner: HTMLElement;
  onTimeout?: () => void;
}): void {
  cleanupWidgetOwner(input.owner);
  let initialLoadFired = false;
  let readyReceived = false;
  const gen = Number(input.owner.dataset.gen || '0');
  input.owner.dataset.gen = String(gen);

  const requestResize = () => {
    input.iframe.contentWindow?.postMessage({ type: 'jaw-request-resize' }, '*');
    setTimeout(() => input.iframe.contentWindow?.postMessage({ type: 'jaw-request-resize' }, '*'), 300);
    setTimeout(() => input.iframe.contentWindow?.postMessage({ type: 'jaw-request-resize' }, '*'), 1000);
  };

  const onLoad = () => {
    if (!initialLoadFired) {
      initialLoadFired = true;
      if (input.iframe.contentWindow) {
        registeredIframes.add(input.iframe.contentWindow);
        iframeNonces.set(input.iframe.contentWindow, input.nonce);
        requestResize();
      }
      return;
    }
    revokeIframeTrust(input.iframe);
    console.warn('[jaw-diagram] iframe navigated — postMessage channel revoked');
  };

  const readyHandler = (e: MessageEvent) => {
    if (e.source !== input.iframe.contentWindow || e.data?.type !== 'jaw-widget-ready') return;
    if (e.data.nonce !== input.nonce) return;
    readyReceived = true;
    window.removeEventListener('message', readyHandler);
  };

  const timeout = window.setTimeout(() => {
    window.removeEventListener('message', readyHandler);
    if (Number(input.owner.dataset.gen || '0') !== gen) return;
    if (readyReceived || !input.owner.isConnected) return;
    revokeIframeTrust(input.iframe);
    input.onTimeout?.();
  }, 10_000);

  const cleanup = () => {
    window.clearTimeout(timeout);
    window.removeEventListener('message', readyHandler);
    input.iframe.removeEventListener('load', onLoad);
    revokeIframeTrust(input.iframe);
  };

  input.iframe.addEventListener('load', onLoad);
  window.addEventListener('message', readyHandler);
  widgetLifecycleCleanups.set(input.owner, cleanup);
}

// ── Cleanup: MutationObserver removes stale iframe refs ──
// Scoped to #chatMessages (not document.body) to avoid firing on every DOM mutation.
let cleanupObserver: MutationObserver | null = null;
function ensureCleanupObserver(): void {
  if (cleanupObserver) return;
  const chatEl = document.getElementById('chatMessages');
  if (!chatEl) return;
  cleanupObserver = new MutationObserver((mutations) => {
    // Early exit: skip if no iframes are registered
    if (!registeredIframes.size) return;
    for (const m of mutations) {
      for (const node of m.removedNodes) {
        if (node instanceof HTMLIFrameElement && node.contentWindow) {
          registeredIframes.delete(node.contentWindow);
          iframeNonces.delete(node.contentWindow);
        }
        if (node instanceof HTMLElement) {
          node.querySelectorAll('iframe').forEach(iframe => {
            if (iframe.contentWindow) {
              registeredIframes.delete(iframe.contentWindow);
              iframeNonces.delete(iframe.contentWindow);
            }
          });
        }
      }
    }
  });
  cleanupObserver.observe(chatEl, { childList: true, subtree: true });
}

// ── Import Map Builder (ES Module bare specifier resolution) ──
function buildImportMap(htmlCode: string): string {
  // Skip if widget already defines its own importmap
  if (htmlCode.includes('"importmap"') || htmlCode.includes("'importmap'")) return '';
  const imports: Record<string, string> = {};
  // Three.js: map bare 'three' to full CDN URL so addons (OrbitControls etc.) resolve
  const threeMatch = htmlCode.match(/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/three@([\d.]+)/);
  if (threeMatch) {
    const ver = threeMatch[1];
    const cdn = htmlCode.includes('unpkg.com/three@') ? 'unpkg.com' : 'cdn.jsdelivr.net/npm';
    const buildPath = cdn === 'unpkg.com' ? 'build/three.module.js' : 'build/three.module.min.js';
    imports['three'] = `https://${cdn}/three@${ver}/${buildPath}`;
    imports['three/addons/'] = `https://${cdn}/three@${ver}/examples/jsm/`;
  }
  if (Object.keys(imports).length === 0) return '';
  return `<script type="importmap">${JSON.stringify({ imports })}<\/script>`;
}

// ── CSP Meta Builder ──
function buildCspMeta(htmlCode: string): string {
  let connectSrc = "'none'";
  // D3 topology needs fetch access to jsdelivr for map data
  if (htmlCode.includes('cdn.jsdelivr.net/npm/us-atlas') ||
      htmlCode.includes('cdn.jsdelivr.net/npm/world-atlas') ||
      htmlCode.includes('cdn.jsdelivr.net/npm/datamaps')) {
    connectSrc = 'https://cdn.jsdelivr.net';
  }

  // Tone.js creates a blob: Worker for its internal clock
  const workerSrc = /Tone(\.min)?\.js|tone@/.test(htmlCode) ? "worker-src blob:;" : '';

  // Base src lists — start from CDN_ALLOWLIST to prevent drift when allowlist changes
  const allowlistUrls = CDN_ALLOWLIST.map(h => `https://${h}`);
  const scriptSrc = allowlistUrls.join(' ');
  const imgSrcs: string[] = ['data:', 'blob:', ...allowlistUrls];
  const styleSrcs: string[] = ["'unsafe-inline'", 'https://fonts.googleapis.com'];

  // Leaflet — narrow signal (real API usage, not bare "leaflet" mentions in prose)
  // Adds OSM tile subdomains (a/b/c, no wildcard) to img-src and Leaflet CSS host to style-src.
  // Marker icons are already covered by CDN_ALLOWLIST baseline in imgSrcs.
  // Regex covers: L.map(), L.tileLayer, L.marker(), L.geoJSON, L.polyline, L.polygon, L.circle,
  // any leaflet asset file (leaflet.js / leaflet.min.js / leaflet-src.esm.js / leaflet@1.9.4/dist/leaflet.js),
  // and direct OSM tile URLs.
  if (/L\.(map|tileLayer|marker|geoJSON|polyline|polygon|circle)\(|leaflet[\w.@/-]*\.(js|css)|tile\.openstreetmap\.org/.test(htmlCode)) {
    imgSrcs.push(
      'https://a.tile.openstreetmap.org',
      'https://b.tile.openstreetmap.org',
      'https://c.tile.openstreetmap.org',
    );
    styleSrcs.push('https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net');
  }

  const imgSrc = imgSrcs.join(' ');
  const styleSrc = styleSrcs.join(' ');
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${scriptSrc}; style-src ${styleSrc}; img-src ${imgSrc}; font-src https://fonts.gstatic.com; connect-src ${connectSrc}; ${workerSrc} base-uri 'none';">`;
}

// ── Theme Token Injection ──
export function getThemeTokens(): { isDark: boolean; tokens: Record<string, string> } {
  const isDark = !document.documentElement.hasAttribute('data-theme') ||
    document.documentElement.getAttribute('data-theme') === 'dark';
  const cs = getComputedStyle(document.documentElement);
  return {
    isDark,
    tokens: {
      '--bg': cs.getPropertyValue('--bg').trim(),
      '--surface': cs.getPropertyValue('--surface').trim(),
      '--border': cs.getPropertyValue('--border').trim(),
      '--text': cs.getPropertyValue('--text').trim(),
      '--text-dim': cs.getPropertyValue('--text-dim').trim(),
      '--accent': cs.getPropertyValue('--accent').trim(),
      '--font-ui': cs.getPropertyValue('--font-ui').trim(),
      '--font-mono': cs.getPropertyValue('--font-mono').trim(),
      '--radius-sm': cs.getPropertyValue('--radius-sm').trim(),
      '--radius-md': cs.getPropertyValue('--radius-md').trim(),
    },
  };
}

// ── Bridge Script (injected into every iframe) ──
function getBridgeScript(nonce: string): string {
  return `
<script>
(function() {
  var __nonce = '${nonce}';

  window.addEventListener('message', function(e) {
    if (e.source !== window.parent) return;
    if (!e.data || typeof e.data !== 'object') return;

    if (e.data.type === 'jaw-theme-update') {
      window.__jawTheme = { isDark: !!e.data.isDark };
      window.__jawTokens = e.data.tokens || {};
      window.dispatchEvent(new CustomEvent('jaw-theme-change', { detail: window.__jawTheme }));
    }
    if (e.data.type === 'jaw-request-resize') {
      postHeight();
    }
    if (e.data.type === 'jaw-request-screenshot') {
      var canvas = document.querySelector('canvas');
      if (canvas) {
        try {
          var dataUrl = canvas.toDataURL('image/png');
          window.parent.postMessage({ type: 'jaw-screenshot', dataUrl: dataUrl, nonce: __nonce }, '*');
        } catch(ex) { /* tainted canvas or other error */ }
      }
    }
  });

  function postHeight() {
    var h = Math.max(
      document.body.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.scrollHeight
    );
    window.parent.postMessage({ type: 'jaw-diagram-resize', height: h, nonce: __nonce }, '*');
  }

  if (typeof ResizeObserver !== 'undefined') {
    var ro = new ResizeObserver(function() {
      clearTimeout(ro._t);
      ro._t = setTimeout(postHeight, 50);
    });
    ro.observe(document.body);
  }

  window.addEventListener('load', function() {
    postHeight();
    // Deferred re-measure for async chart renders (Chart.js animation, CDN loading)
    setTimeout(postHeight, 200);
    setTimeout(postHeight, 800);
    window.parent.postMessage({ type: 'jaw-widget-ready', nonce: __nonce }, '*');
  });

  var lastSend = 0;
  window.sendPrompt = function(text) {
    var now = Date.now();
    if (now - lastSend < 3000) return;
    lastSend = now;
    window.parent.postMessage({ type: 'jaw-send-prompt', text: String(text).slice(0, 500), nonce: __nonce }, '*');
  };

  // Ctrl+C / Cmd+C: forward selected text to host for clipboard access
  document.addEventListener('copy', function() {
    var sel = window.getSelection();
    if (sel && sel.toString().trim()) {
      window.parent.postMessage({
        type: 'jaw-copy-text',
        text: sel.toString().slice(0, 512),
        nonce: __nonce
      }, '*');
    }
  });
})();
<\/script>`;
}

// ── CDN Version Corrections (fix known bad versions in existing messages) ──
const CDN_VERSION_FIXES: [RegExp, string][] = [
  [/\/p5\.js\/1\.11\.1[1-9]\//g, '/p5.js/1.11.10/'],
];
function fixCdnVersions(html: string): string {
  for (const [pattern, replacement] of CDN_VERSION_FIXES) html = html.replace(pattern, replacement);
  return html;
}

// ── iframe Creator ──
export function createWidgetIframe(htmlCode: string): { iframe: HTMLIFrameElement; nonce: string } {
  ensureCleanupObserver();
  ensureWidgetObserver();

  htmlCode = fixCdnVersions(htmlCode);

  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    b => b.toString(16).padStart(2, '0')).join('');

  const theme = getThemeTokens();
  const cspMeta = buildCspMeta(htmlCode);
  const importMap = buildImportMap(htmlCode);
  const bridge = getBridgeScript(nonce);

  const cssVars = Object.entries(theme.tokens)
    .map(([k, v]) => `${k}: ${v};`)
    .join('\n      ');

  const srcdoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  ${cspMeta}
  ${importMap}
  <style>
    :root { ${cssVars} }
    * { margin: 0; box-sizing: border-box; }
    body {
      font-family: var(--font-ui), system-ui, sans-serif;
      color: var(--text);
      background: transparent;
      padding: 16px;
      overflow: hidden;
    }
  </style>
</head>
<body>
  <script>
    window.__jawTheme = ${JSON.stringify({ isDark: theme.isDark })};
    window.__jawTokens = ${JSON.stringify(theme.tokens).replace(/<\//g, '<\\/')};
  <\/script>
  ${bridge}
  ${htmlCode}
</body>
</html>`;

  const iframe = document.createElement('iframe');
  iframe.sandbox.add('allow-scripts');
  iframe.srcdoc = srcdoc;
  iframe.style.cssText = 'width: 100%; min-height: 200px; border: none; overflow: hidden; display: block;';
  iframe.setAttribute('aria-label', 'Interactive diagram widget');

  return { iframe, nonce };
}

// ── Activate All Pending Widgets ──
export function activateWidgets(container?: HTMLElement): void {
  const root = container || document;
  root.querySelectorAll('.diagram-widget-pending').forEach(el => {
    const encoded = (el as HTMLElement).dataset.diagramHtml;
    if (!encoded) return;
    let htmlCode: string;
    try {
      htmlCode = decodeWidgetHtml(encoded);
    } catch {
      el.replaceWith(Object.assign(document.createElement('div'), {
        className: 'diagram-error',
        textContent: 'Failed to decode widget content',
        role: 'alert',
      }));
      return;
    }

    // Validate widget HTML before iframe injection
    const validation = validateWidgetHtml(htmlCode);
    if (!validation.valid) {
      el.replaceWith(Object.assign(document.createElement('div'), {
        className: 'diagram-error',
        textContent: `Widget blocked: ${validation.reason}`,
        role: 'alert',
      }));
      return;
    }
    if (validation.warnings.length) {
      console.warn('[jaw-diagram] Widget warnings:', validation.warnings);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'diagram-container diagram-widget';
    // Preserve source for theme-change reload
    wrapper.dataset.widgetHtml = encoded;

    wrapper.appendChild(createDiagramZoomBtn());
    wrapper.appendChild(createDiagramSaveBtn());
    wrapper.appendChild(createDiagramCopyBtn());
    const { iframe, nonce } = createWidgetIframe(htmlCode);
    wrapper.appendChild(iframe);
    bindWidgetZoom(wrapper);

    el.replaceWith(wrapper);

    attachWidgetIframeLifecycle({
      iframe,
      nonce,
      owner: wrapper,
      onTimeout: () => {
        wrapper.innerHTML = `<div class="diagram-error" role="alert">
          Widget failed to load within 10 seconds.
        </div>`;
        console.warn('[jaw-diagram] Widget timeout — iframe deregistered');
      },
    });
  });
}

function bindWidgetZoom(container: HTMLElement): void {
  const btn = container.querySelector('.diagram-zoom-btn') as HTMLButtonElement | null;
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    const encoded = container.dataset.widgetHtml;
    if (!encoded) return;
    openWidgetOverlay(encoded);
  });
}

function decodeWidgetHtml(encoded: string): string {
  if (encoded.length > 524_288) throw new Error('Widget payload too large');
  return decodeURIComponent(escape(atob(encoded)));
}

function openWidgetOverlay(encoded: string): void {
  const previousFocus = document.activeElement as HTMLElement | null;
  let htmlCode: string;
  try {
    htmlCode = decodeWidgetHtml(encoded);
  } catch {
    htmlCode = '';
  }

  const overlay = document.createElement('div');
  overlay.className = 'diagram-overlay diagram-widget-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Expanded interactive diagram');

  const content = document.createElement('div');
  content.className = 'diagram-overlay-content';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'diagram-overlay-close';
  closeBtn.type = 'button';
  closeBtn.ariaLabel = 'Close';
  closeBtn.textContent = '✕';
  overlay.append(content, closeBtn);

  const close = () => {
    cleanupWidgetOwner(content);
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    const focusable = overlay.querySelectorAll<HTMLElement>(
      'button, [href], iframe, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  };

  const validation = htmlCode ? validateWidgetHtml(htmlCode) : { valid: false, reason: 'Failed to decode widget content', warnings: [] };
  if (!validation.valid) {
    content.innerHTML = `<div class="diagram-error" role="alert">Widget blocked: ${validation.reason}</div>`;
  } else {
    const widget = document.createElement('div');
    widget.className = 'diagram-container diagram-widget diagram-widget-expanded';
    widget.dataset.widgetHtml = encoded;
    const sizeBtn = createDiagramSizeToggleBtn();
    sizeBtn.addEventListener('click', () => {
      const maximized = overlay.classList.toggle('maximized');
      sizeBtn.textContent = maximized ? '⤡' : '⤢';
      sizeBtn.title = maximized ? 'Shrink' : 'Expand';
      sizeBtn.ariaLabel = maximized ? 'Shrink diagram' : 'Expand diagram';
    });
    widget.append(createDiagramSaveBtn(), createDiagramCopyBtn(), sizeBtn);
    const { iframe, nonce } = createWidgetIframe(htmlCode);
    widget.appendChild(iframe);
    content.appendChild(widget);
    attachWidgetIframeLifecycle({ iframe, nonce, owner: content });
  }

  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  closeBtn.focus();
}

// ── Widget Reactivation Observer ──
// Only watches direct children of #chatMessages (not subtree) to avoid
// firing on every streaming innerHTML update inside message bubbles.
let widgetObserver: MutationObserver | null = null;
function ensureWidgetObserver(): void {
  if (widgetObserver) return;
  const chatEl = document.getElementById('chatMessages');
  if (!chatEl) return;
  widgetObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const hasPending = node.classList?.contains('diagram-widget-pending') ||
          node.querySelector?.('.diagram-widget-pending');
        if (hasPending) {
          requestAnimationFrame(() => activateWidgets(node.parentElement || chatEl));
          return;
        }
      }
    }
  });
  // childList only (no subtree) — new messages are appended as direct children.
  // activateWidgets is also called explicitly in ui.ts after rendering.
  widgetObserver.observe(chatEl, { childList: true });
}

// ── Resize Throttle (max 1 per 100ms per iframe) ──
const resizeTimers = new WeakMap<Window, number>();

function throttledResize(source: Window, height: number): void {
  if (resizeTimers.has(source)) return;
  resizeTimers.set(source, window.setTimeout(() => resizeTimers.delete(source), 100));

  document.querySelectorAll('iframe').forEach(iframe => {
    if (iframe.contentWindow === source) {
      iframe.style.height = `${Math.min(Math.max(height, 60), 2000)}px`;
    }
  });
}

// ── Theme Broadcast to All Widget iframes ──
// Also recreates iframes so baked-in chart colors update with new theme.
export function broadcastThemeToIframes(): void {
  document.querySelectorAll('.diagram-widget').forEach(container => {
    const encoded = (container as HTMLElement).dataset.widgetHtml;
    if (!encoded) return;
    let htmlCode: string;
    try {
      htmlCode = decodeWidgetHtml(encoded);
    } catch { return; }

    // Deregister old iframe
    const oldIframe = container.querySelector('iframe') as HTMLIFrameElement | null;
    if (oldIframe?.contentWindow) {
      registeredIframes.delete(oldIframe.contentWindow);
      iframeNonces.delete(oldIframe.contentWindow);
    }

    // Bump generation to invalidate pending timeouts from activateWidgets
    const cEl = container as HTMLElement;
    cEl.dataset.gen = String((Number(cEl.dataset.gen || '0') || 0) + 1);

    // Recreate with fresh theme tokens
    const { iframe, nonce } = createWidgetIframe(htmlCode);
    container.innerHTML = '';
    container.appendChild(createDiagramZoomBtn());
    container.appendChild(createDiagramSaveBtn());
    container.appendChild(createDiagramCopyBtn());
    container.appendChild(iframe);
    bindWidgetZoom(container as HTMLElement);
    attachWidgetIframeLifecycle({ iframe, nonce, owner: container as HTMLElement });
  });
}

// ── Host postMessage Listener ──
let lastHostSendPrompt = 0;
window.addEventListener('message', (e: MessageEvent) => {
  if (!e.data || typeof e.data !== 'object') return;
  if (!e.source) return;
  // Defense-in-depth: sandbox="allow-scripts" without allow-same-origin → opaque origin ("null")
  if (e.origin !== 'null') return;
  if (!registeredIframes.has(e.source as Window)) return;
  // Reject messages from iframes removed from DOM
  const sourceIframe = [...document.querySelectorAll('iframe')].find(f => f.contentWindow === e.source);
  if (!sourceIframe?.isConnected) return;
  // Validate per-iframe nonce
  const expectedNonce = iframeNonces.get(e.source as Window);
  if (!expectedNonce || e.data.nonce !== expectedNonce) return;

  switch (e.data.type) {
    case 'jaw-diagram-resize': {
      const h = Number(e.data.height);
      if (!Number.isFinite(h) || h < 0) return;
      throttledResize(e.source as Window, h);
      break;
    }

    case 'jaw-send-prompt': {
      const now = Date.now();
      if (now - lastHostSendPrompt < 3000) return;
      lastHostSendPrompt = now;

      const text = String(e.data.text || '').trim().slice(0, 500);
      if (!text) return;
      const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
      if (input) {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      }
      break;
    }

    case 'jaw-copy-text': {
      const text = String(e.data.text || '').trim().slice(0, 512);
      if (!text) return;
      navigator.clipboard.writeText(text).catch(() => {});
      break;
    }

    case 'jaw-screenshot': {
      const dataUrl = String(e.data.dataUrl || '');
      if (!dataUrl.startsWith('data:image/')) return;
      // Cap at 5 MB to prevent abuse
      if (dataUrl.length > 5_242_880) return;
      fetch(dataUrl).then(r => r.blob()).then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `widget-${Date.now()}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }).catch(() => {});
      break;
    }

    case 'jaw-widget-ready':
      break;
  }
});
