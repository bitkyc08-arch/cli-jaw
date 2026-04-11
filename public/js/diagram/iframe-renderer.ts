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

// ── CDN Allowlist (Phase 5 libraries) ──
const CDN_ALLOWLIST = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// ── Registered iframes for postMessage validation ──
const registeredIframes = new Set<Window>();

// ── Per-iframe nonces for navigation defense ──
const iframeNonces = new Map<Window, string>();

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

// ── CSP Meta Builder ──
function buildCspMeta(htmlCode: string): string {
  let connectSrc = "'none'";
  // D3 topology needs fetch access to jsdelivr for map data
  if (htmlCode.includes('cdn.jsdelivr.net/npm/us-atlas') ||
      htmlCode.includes('cdn.jsdelivr.net/npm/world-atlas') ||
      htmlCode.includes('cdn.jsdelivr.net/npm/datamaps')) {
    connectSrc = 'https://cdn.jsdelivr.net';
  }

  const scriptSrc = CDN_ALLOWLIST.map(h => `https://${h}`).join(' ');
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${scriptSrc}; style-src 'unsafe-inline' https://fonts.googleapis.com; img-src data: blob:; font-src https://fonts.gstatic.com; connect-src ${connectSrc}; base-uri 'none';">`;
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

// ── iframe Creator ──
export function createWidgetIframe(htmlCode: string): { iframe: HTMLIFrameElement; nonce: string } {
  ensureCleanupObserver();
  ensureWidgetObserver();

  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    b => b.toString(16).padStart(2, '0')).join('');

  const theme = getThemeTokens();
  const cspMeta = buildCspMeta(htmlCode);
  const bridge = getBridgeScript(nonce);

  const cssVars = Object.entries(theme.tokens)
    .map(([k, v]) => `${k}: ${v};`)
    .join('\n      ');

  const srcdoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  ${cspMeta}
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
  iframe.style.cssText = 'width: 100%; border: none; overflow: hidden; display: block;';
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
      // Cap widget payload at 512 KB to prevent memory/CPU abuse
      if (encoded.length > 524_288) {
        throw new Error('Widget payload too large');
      }
      htmlCode = decodeURIComponent(escape(atob(encoded)));
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

    wrapper.appendChild(createDiagramSaveBtn());
    wrapper.appendChild(createDiagramCopyBtn());
    const { iframe, nonce } = createWidgetIframe(htmlCode);
    wrapper.appendChild(iframe);

    el.replaceWith(wrapper);

    // Navigation defense: register ONLY on the first load event.
    // No pre-load registration — prevents race where widget JS reads
    // the nonce and self-navigates before the first load fires.
    let initialLoadFired = false;
    iframe.addEventListener('load', () => {
      if (!initialLoadFired) {
        initialLoadFired = true;
        if (iframe.contentWindow) {
          registeredIframes.add(iframe.contentWindow);
          iframeNonces.set(iframe.contentWindow, nonce);
          // Request initial resize now that channel is established
          iframe.contentWindow.postMessage({ type: 'jaw-request-resize' }, '*');
          // Deferred resize for slow CDN loads / async chart renders
          setTimeout(() => iframe.contentWindow?.postMessage({ type: 'jaw-request-resize' }, '*'), 300);
          setTimeout(() => iframe.contentWindow?.postMessage({ type: 'jaw-request-resize' }, '*'), 1000);
        }
      } else {
        // Navigation detected — revoke postMessage trust permanently
        if (iframe.contentWindow) {
          registeredIframes.delete(iframe.contentWindow);
          iframeNonces.delete(iframe.contentWindow);
        }
        console.warn('[jaw-diagram] iframe navigated — postMessage channel revoked');
      }
    });

    // Timeout: if no jaw-widget-ready within 10s, show error.
    // Uses a generation counter to detect iframe recreation (theme toggle).
    const gen = Number(wrapper.dataset.gen || '0');
    wrapper.dataset.gen = String(gen);
    let readyReceived = false;
    const readyHandler = (e: MessageEvent) => {
      if (e.source === iframe.contentWindow && e.data?.type === 'jaw-widget-ready'
          && e.data.nonce === nonce) {
        readyReceived = true;
        window.removeEventListener('message', readyHandler);
      }
    };
    window.addEventListener('message', readyHandler);

    setTimeout(() => {
      window.removeEventListener('message', readyHandler);
      // Skip if iframe was recreated (e.g. theme toggle)
      if (Number(wrapper.dataset.gen || '0') !== gen) return;
      if (!readyReceived && wrapper.isConnected) {
        const failedWin = iframe.contentWindow;
        if (failedWin) {
          registeredIframes.delete(failedWin);
          iframeNonces.delete(failedWin);
        }
        wrapper.innerHTML = `<div class="diagram-error" role="alert">
          Widget failed to load within 10 seconds.
        </div>`;
        console.warn('[jaw-diagram] Widget timeout — iframe deregistered');
      }
    }, 10_000);
  });
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
      htmlCode = decodeURIComponent(escape(atob(encoded)));
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
    container.appendChild(createDiagramSaveBtn());
    container.appendChild(createDiagramCopyBtn());
    container.appendChild(iframe);

    let initialLoadFired = false;
    iframe.addEventListener('load', () => {
      if (!initialLoadFired) {
        initialLoadFired = true;
        if (iframe.contentWindow) {
          registeredIframes.add(iframe.contentWindow);
          iframeNonces.set(iframe.contentWindow, nonce);
          iframe.contentWindow.postMessage({ type: 'jaw-request-resize' }, '*');
          setTimeout(() => iframe.contentWindow?.postMessage({ type: 'jaw-request-resize' }, '*'), 300);
          setTimeout(() => iframe.contentWindow?.postMessage({ type: 'jaw-request-resize' }, '*'), 1000);
        }
      } else {
        if (iframe.contentWindow) {
          registeredIframes.delete(iframe.contentWindow);
          iframeNonces.delete(iframe.contentWindow);
        }
      }
    });
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
