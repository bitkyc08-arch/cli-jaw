// ── Render Helpers ──
// Modular markdown rendering: marked + highlight.js + KaTeX + Mermaid
// All libs bundled via npm imports; mermaid lazy-loaded on first use

import { marked, Renderer } from 'marked';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import diff from 'highlight.js/lib/languages/diff';
import plaintext from 'highlight.js/lib/languages/plaintext';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { t } from './features/i18n.js';
import { ICONS } from './icons.js';
import { fixCjkPunctuationBoundary } from './cjk-fix.js';
import {
    SvgBlock, shieldCodeFenceSvg, unshieldCodeFenceSvg,
    extractTopLevelSvg,
} from './diagram/types.js';

// Register hljs languages (core-only import: ~25KB vs ~1MB full)
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sh', shell);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', cpp);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('text', plaintext);

// Lazy mermaid: loaded on first diagram encounter
let mermaidModule: typeof import('mermaid') | null = null;

async function getMermaid() {
    if (!mermaidModule) {
        mermaidModule = await import('mermaid');
        mermaidModule.default.initialize({
            startOnLoad: false,
            theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'dark',
            securityLevel: 'strict',
        });
    }
    return mermaidModule.default;
}

export function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── XSS sanitization (hardened for inline SVG — Phase 1) ──
export function sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true, svg: true, svgFilters: true },
        FORBID_TAGS: [
            'script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
            // SVG security: block animation + foreignObject (script injection vectors)
            'foreignObject', 'animate', 'set', 'animateTransform', 'animateMotion',
        ],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur',
                      'background'],  // legacy HTML attr that triggers remote fetch
        ADD_TAGS: ['use'],
        ADD_ATTR: ['aria-hidden', 'xmlns', 'viewBox', 'role', 'aria-label',
                   'data-jaw-svg', 'data-jaw-kind'],
    });
}

// Hook: strip external href/xlink:href on <use> and <image>
// Only fragment references (#id) allowed — blocks external resource loading.
const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_HREF_ALLOWED = new Set(['a', 'area', 'link']);

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const tag = node.tagName.toLowerCase();

    // ── href / xlink:href: deny-by-default ──
    // Only standard HTML (non-SVG) elements in the allow-set may carry external href.
    // SVG <a> shares tagName 'a' with HTML <a>, so we also check namespaceURI
    // to distinguish them — SVG elements always get fragment-only.
    const isSvgElement = node.namespaceURI === SVG_NS;
    if (isSvgElement || !HTML_HREF_ALLOWED.has(tag)) {
        const href = node.getAttribute('href') || '';
        if (href && !href.startsWith('#')) {
            node.removeAttribute('href');
        }
    }
    // xlink:href is SVG-only — always enforce fragment-only on ALL elements
    const xlinkHref = node.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        || node.getAttribute('xlink:href') || '';
    if (xlinkHref && !xlinkHref.startsWith('#')) {
        node.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
        node.removeAttribute('xlink:href');
    }
    // SVG <image>/<feimage> may carry src in HTML parser context (belt-and-suspenders)
    if (tag === 'image' || tag === 'feimage') {
        const src = node.getAttribute('src') || '';
        if (src && !src.startsWith('#')) {
            node.removeAttribute('src');
        }
    }
    // Strip external url() from style and SVG presentation attributes
    // Prevents outbound requests / beaconing via CSS or SVG attrs like
    // filter="url(https://evil)", fill="url(https://evil)", mask, clip-path, marker-*
    const URL_CAPABLE_ATTRS = [
        'fill', 'stroke', 'filter', 'mask', 'clip-path',
        'marker-start', 'marker-mid', 'marker-end', 'cursor',
    ];
    // For style: use cssText (browser-parsed) to defeat CSS hex-escape bypass (\75\72\6c = url)
    if (node.hasAttribute('style')) {
        const cssText = (node as HTMLElement).style?.cssText || '';
        if (/url\s*\(/i.test(cssText)) {
            const cleaned = cssText.replace(/url\s*\(\s*(?!['"]?#)[^)]*\)/gi, 'none');
            (node as HTMLElement).style.cssText = cleaned;
        }
    }
    for (const attr of URL_CAPABLE_ATTRS) {
        if (node.hasAttribute(attr)) {
            const val = node.getAttribute(attr) || '';
            if (/url\s*\(/i.test(val)) {
                // Keep fragment-only url(#id), strip external url()
                const cleaned = val.replace(/url\s*\(\s*(?!['"]?#)[^)]*\)/gi, 'none');
                node.setAttribute(attr, cleaned);
            }
        }
    }
});

// ── Orchestration JSON stripping ──
// Only strip JSON blocks that contain orchestration-specific keys, not all JSON blocks
// Require keys unique to orchestration payloads (avoid generic words like "phase")
const ORCH_KEYS = /["'](?:subtasks|employee_config|agent_phases|orchestration_plan)["']\s*:/;
export function stripOrchestration(text: string): string {
    // Strip fenced JSON blocks only if they contain orchestration keys
    let cleaned = text.replace(/```json\n([\s\S]*?)\n```/g, (_match, inner) =>
        ORCH_KEYS.test(inner) ? '' : _match);
    // Strip inline orchestration objects containing subtasks array
    cleaned = cleaned.replace(/\{[^{}]*"subtasks"\s*:\s*\[[\s\S]*?\]\s*\}/g, '').trim();
    return cleaned;
}

// ── KaTeX math shield/unshield ──
// Shield: marked 전에 수식을 플레이스홀더로 치환 (marked가 $를 파괴하는 것 방지)
// Unshield: marked 후에 플레이스홀더를 KaTeX 렌더링으로 복원

interface MathBlock { tex: string; displayMode: boolean; }

export function shieldMath(text: string): { text: string; blocks: MathBlock[] } {
    const blocks: MathBlock[] = [];
    // 1. 코드 블록/인라인 코드 보존 (수식 추출 대상에서 제외)
    const preserved: string[] = [];
    let processed = text
        .replace(/```[\s\S]*?```/g, (m) => {
            preserved.push(m); return `\x00C${preserved.length - 1}\x00`;
        })
        .replace(/`[^`]+`/g, (m) => {
            preserved.push(m); return `\x00C${preserved.length - 1}\x00`;
        });

    // 2. Block math: $$...$$ (먼저 — greedy 방지)
    processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => {
        blocks.push({ tex: tex.trim(), displayMode: true });
        return `\x00MATH-${blocks.length - 1}\x00`;
    });

    // 3. GPT-style block math: \[...\]
    processed = processed.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => {
        blocks.push({ tex: tex.trim(), displayMode: true });
        return `\x00MATH-${blocks.length - 1}\x00`;
    });

    // 4. Inline math: $...$ (통화 $10 제외)
    processed = processed.replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g, (_, tex: string) => {
        blocks.push({ tex: tex.trim(), displayMode: false });
        return `\x00MATH-${blocks.length - 1}\x00`;
    });

    // 5. GPT-style inline math: \(...\)
    processed = processed.replace(/\\\((.+?)\\\)/g, (_, tex: string) => {
        blocks.push({ tex: tex.trim(), displayMode: false });
        return `\x00MATH-${blocks.length - 1}\x00`;
    });

    // 4. 코드 블록 복원
    processed = processed.replace(/\x00C(\d+)\x00/g, (_, i) => preserved[Number(i)]);

    return { text: processed, blocks };
}

export function unshieldMath(html: string, blocks: MathBlock[]): string {
    return html.replace(/\x00MATH-(\d+)\x00/g, (_, i) => {
        const block = blocks[Number(i)];
        if (!block) return `<code title="math placeholder error">[math error]</code>`;
        try {
            return katex.renderToString(block.tex, {
                displayMode: block.displayMode,
                throwOnError: false,
            });
        } catch {
            return block.displayMode
                ? `<pre><code>${escapeHtml(block.tex)}</code></pre>`
                : `<code>${escapeHtml(block.tex)}</code>`;
        }
    });
}

// ── Mermaid deferred rendering (lazy-loaded) ──
let mermaidId = 0;

function renderMermaidBlocks(): void {
    const pending = document.querySelectorAll('.mermaid-pending');
    if (!pending.length) return;
    pending.forEach(async (el) => {
        el.classList.remove('mermaid-pending');
        const code = el.textContent || '';
        const id = `mermaid-${++mermaidId}`;
        try {
            const mm = await getMermaid();
            const { svg } = await mm.render(id, code);
            el.innerHTML = sanitizeHtml(svg);
            el.classList.add('mermaid-rendered');
        } catch (err: unknown) {
            const errMsg = (err as { message?: string; str?: string })?.message
                || (err as { str?: string })?.str || 'Unknown error';
            el.innerHTML = `
                <div class="mermaid-error">
                    <div class="mermaid-error-title">${ICONS.warning} ${escapeHtml(t('mermaid.renderFail') || 'Mermaid render failed')}</div>
                    <div class="mermaid-error-msg">${escapeHtml(errMsg.slice(0, 200))}</div>
                    <pre class="mermaid-error-code"><code>${escapeHtml(code)}</code></pre>
                </div>`;
        }
    });
}

// ── marked.js configuration (ES module — always available) ──
let markedReady = false;

function ensureMarked(): boolean {
    if (markedReady) return true;

    const renderer = new Renderer();

    // Code blocks: highlight.js + mermaid + diagram-html detection
    renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
        if (lang === 'mermaid') {
            return `<div class="mermaid-container mermaid-pending">${escapeHtml(text)}</div>`;
        }
        // diagram-html: encode as base64, Phase 2 activateWidgets() inflates to sandboxed iframe
        if (lang === 'diagram-html') {
            const encoded = btoa(unescape(encodeURIComponent(text)));
            return `<div class="diagram-widget-pending" data-diagram-html="${encoded}"
                role="status" aria-label="Interactive widget loading">
                <div class="diagram-spinner"></div>
            </div>`;
        }
        let highlighted = escapeHtml(text);
        if (lang && hljs.getLanguage(lang)) {
            try {
                highlighted = hljs.highlight(text, { language: lang }).value;
            } catch { /* fallback to escaped */ }
        } else {
            try {
                highlighted = hljs.highlightAuto(text).value;
            } catch { /* fallback */ }
        }
        const langDisplay = lang ? escapeHtml(lang) : '';
        const copyLabel = t('code.copy') || 'Copy';
        return `<div class="code-block"><div class="code-header"><span class="code-lang">${langDisplay}</span><button class="code-copy-btn" type="button" aria-label="${escapeHtml(copyLabel)}">${escapeHtml(copyLabel)}</button></div><pre><code class="hljs${lang ? ` language-${escapeHtml(lang)}` : ''}">${highlighted}</code></pre></div>`;
    };

    marked.setOptions({
        renderer,
        gfm: true,
        breaks: false,
    });

    markedReady = true;
    return true;
}

// ── Rehighlight all code blocks ──
export function rehighlightAll(): void {
    document.querySelectorAll('.code-block pre code, .code-block-wrapper pre code').forEach(el => {
        if ((el as HTMLElement).dataset.highlighted === 'yes') return;
        const lang = [...el.classList].find(c => c.startsWith('language-'))?.replace('language-', '');
        const raw = el.textContent || '';
        try {
            if (lang && hljs.getLanguage(lang)) {
                el.innerHTML = hljs.highlight(raw, { language: lang }).value;
            } else {
                el.innerHTML = hljs.highlightAuto(raw).value;
            }
            (el as HTMLElement).dataset.highlighted = 'yes';
        } catch { /* ignore */ }
    });
}

// ── Copy button event delegation (one-time setup) ──
let copyDelegationReady = false;

function ensureCopyDelegation(): void {
    if (copyDelegationReady) return;
    copyDelegationReady = true;
    document.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        // New structure: .code-copy-btn inside .code-block
        const copyBtn = target?.closest('.code-copy-btn') as HTMLElement | null;
        if (copyBtn) {
            const block = copyBtn.closest('.code-block');
            if (!block) return;
            const codeEl = block.querySelector('pre code');
            if (!codeEl) return;
            navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
                const orig = copyBtn.textContent || '';
                copyBtn.textContent = t('code.copied');
                copyBtn.classList.add('copied');
                setTimeout(() => {
                    copyBtn.textContent = orig;
                    copyBtn.classList.remove('copied');
                }, 1500);
            }).catch(() => { /* clipboard API fail silently */ });
            return;
        }
        // Legacy structure: .code-lang-label inside .code-block-wrapper
        const label = target?.closest('.code-lang-label') as HTMLElement | null;
        if (!label) return;
        const wrapper = label.closest('.code-block-wrapper');
        if (!wrapper) return;
        const codeEl = wrapper.querySelector('pre code');
        if (!codeEl) return;
        navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
            const orig = label.textContent || '';
            label.textContent = t('code.copied');
            label.classList.add('copied');
            setTimeout(() => {
                label.textContent = orig;
                label.classList.remove('copied');
            }, 1500);
        }).catch(() => { /* clipboard API fail silently */ });
    });
}

// ── SVG Block Rendering (Phase 1) ──

function renderSvgBlock(block: SvgBlock): string {
    if (block.kind === 'partial') {
        return `<div class="diagram-container diagram-loading" role="status"
            aria-label="Diagram loading"><div class="diagram-spinner"></div></div>`;
    }
    if (block.kind === 'error') {
        return `<div class="diagram-container diagram-error" role="alert">
            Malformed SVG: unclosed element</div>`;
    }
    // Complete SVG — sanitize individually (extracted SVGs bypass main pipeline)
    const sanitized = sanitizeHtml(block.svg);
    return `<div class="diagram-container diagram-svg" tabindex="0"
        role="figure" aria-label="SVG diagram">
        ${sanitized}
        <button class="diagram-zoom-btn" type="button"
            aria-label="Expand diagram" title="Expand">⤢</button>
    </div>`;
}

function unshieldSvgBlocks(html: string, blocks: SvgBlock[]): string {
    for (const block of blocks) {
        const pattern = `<div\\b[^>]*?\\bdata-jaw-svg="${block.id}"[^>]*></div>`;
        const re = new RegExp(pattern, 'g');
        const rendered = renderSvgBlock(block);
        // Use function replacement to avoid $& $' $` special patterns in SVG content
        html = html.replace(re, () => rendered);
    }
    return html;
}

// ── Diagram Zoom Overlay ──

export function bindDiagramZoom(): void {
    document.querySelectorAll('.diagram-zoom-btn').forEach(btn => {
        if ((btn as HTMLElement).dataset.bound) return;
        (btn as HTMLElement).dataset.bound = '1';
        btn.addEventListener('click', () => {
            const container = btn.closest('.diagram-container');
            if (!container) return;
            // Clone without zoom button to prevent nesting
            const clone = container.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('.diagram-zoom-btn').forEach(b => b.remove());
            openDiagramOverlay(clone.innerHTML);
        });
    });
}

export function openDiagramOverlay(innerHtml: string): void {
    const previousFocus = document.activeElement as HTMLElement | null;
    const overlay = document.createElement('div');
    overlay.className = 'diagram-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Expanded diagram');
    // Re-sanitize to prevent mXSS from double HTML parsing
    const safeHtml = sanitizeHtml(innerHtml);
    overlay.innerHTML = `
        <div class="diagram-overlay-content">${safeHtml}</div>
        <button class="diagram-overlay-close" type="button" aria-label="Close">✕</button>
    `;

    const closeBtn = overlay.querySelector('.diagram-overlay-close') as HTMLElement;

    const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        // Restore focus to the element that opened the overlay
        if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { close(); return; }
        // Focus trap: Tab cycles within overlay
        if (e.key === 'Tab') {
            const focusable = overlay.querySelectorAll<HTMLElement>(
                'button, [href], [tabindex]:not([tabindex="-1"])');
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault(); last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault(); first.focus();
            }
        }
    };

    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    closeBtn.focus();
}

// ── Main export ──
export function renderMarkdown(text: string, isStreaming = false): string {
    const rawCleaned = stripOrchestration(text);
    if (!rawCleaned) return `<em class="text-dim orchestrate-placeholder">${escapeHtml(t('orchestrator.dispatching'))}</em>`;
    // Collapse 3+ consecutive newlines → double newline (prevents excessive paragraph breaks)
    const cleaned = rawCleaned.replace(/\n{3,}/g, '\n\n');

    // 1. Shield code fences (protect SVG in code blocks)
    const { text: fenceShielded, fences } = shieldCodeFenceSvg(cleaned);

    // 2. Extract top-level SVGs
    const { text: svgShielded, blocks: svgBlocks } = extractTopLevelSvg(fenceShielded, isStreaming);

    // 3. Unshield code fences (restore for marked processing)
    const restored = unshieldCodeFenceSvg(svgShielded, fences);

    // 4. Shield math
    const { text: shielded, blocks: mathBlocks } = shieldMath(restored);

    // 5. Marked parse
    ensureMarked();
    const fixed = fixCjkPunctuationBoundary(shielded);
    let html = marked.parse(fixed) as string;
    html = html.replace(/<table/g, '<div class="table-wrapper"><table').replace(/<\/table>/g, '</table></div>');

    // 6. Unshield math
    html = unshieldMath(html, mathBlocks);

    // 7. Sanitize
    html = sanitizeHtml(html);

    // 8. Unshield SVGs (after sanitize — SVGs sanitized individually in renderSvgBlock)
    html = unshieldSvgBlocks(html, svgBlocks);

    // 9. Post-render async tasks
    requestAnimationFrame(() => {
        renderMermaidBlocks();
        rehighlightAll();
        bindDiagramZoom();
    });

    ensureCopyDelegation();

    return html;
}
