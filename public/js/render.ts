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
let mermaidTheme: string | null = null;

function getMermaidThemeVars() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    return isLight ? {
        primaryColor: '#e2e8f0',
        primaryTextColor: '#1a202c',
        primaryBorderColor: '#a0aec0',
        lineColor: '#718096',
        secondaryColor: '#ebf8ff',
        tertiaryColor: '#f7fafc',
        background: 'transparent',
        mainBkg: '#e2e8f0',
        nodeBorder: '#a0aec0',
        clusterBkg: '#f7fafc',
        clusterBorder: '#cbd5e0',
        titleColor: '#1a202c',
        edgeLabelBackground: '#f7fafc',
    } : {
        primaryColor: '#2d3748',
        primaryTextColor: '#e2e8f0',
        primaryBorderColor: '#4a5568',
        lineColor: '#718096',
        secondaryColor: '#1a365d',
        tertiaryColor: '#1a202c',
        background: 'transparent',
        mainBkg: '#2d3748',
        nodeBorder: '#4a5568',
        clusterBkg: '#1a202c',
        clusterBorder: '#2d3748',
        titleColor: '#e2e8f0',
        edgeLabelBackground: '#1a202c',
    };
}

async function getMermaid() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    if (!mermaidModule) {
        mermaidModule = await import('mermaid');
    }
    if (mermaidTheme !== currentTheme) {
        mermaidTheme = currentTheme;
        mermaidModule.default.initialize({
            startOnLoad: false,
            theme: 'base',
            themeVariables: getMermaidThemeVars(),
            securityLevel: 'strict',
        });
    }
    return mermaidModule.default;
}

// Mermaid SVG sanitizer — allows <style> (required for Mermaid theming)
// Separate from sanitizeHtml() which blocks <style> for user-supplied SVGs.
// Mermaid is configured with htmlLabels:false so labels use SVG <text>,
// not <foreignObject> + HTML. This avoids DOMPurify namespace issues.
function sanitizeMermaidSvg(svg: string): string {
    const clean = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: [
            'script', 'iframe', 'object', 'embed', 'form', 'input',
            'foreignObject', 'animate', 'set', 'animateTransform', 'animateMotion',
        ],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur',
                      'background'],
    });
    // Sanitize CSS inside <style> blocks: strip @import, @font-face, external url()
    const div = document.createElement('div');
    div.innerHTML = clean;
    for (const style of div.querySelectorAll('style')) {
        let css = style.textContent || '';
        css = css.replace(/@import\b[^;]*;?/gi, '/* stripped */');
        css = css.replace(/@font-face\s*\{[^}]*\}/gi, '/* stripped */');
        css = css.replace(/url\s*\(\s*(?!['"]?#)[^)]*\)/gi, 'none');
        style.textContent = css;
    }
    return div.innerHTML;
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

/** Re-render all existing Mermaid diagrams (call on theme toggle). */
export async function rerenderMermaidDiagrams(): Promise<void> {
    mermaidTheme = null; // force re-init with new theme vars
    const rendered = document.querySelectorAll('.mermaid-rendered');
    if (!rendered.length) return;
    const mm = await getMermaid();
    for (const el of rendered) {
        const code = (el as HTMLElement).dataset.mermaidCode;
        if (!code) continue;
        const id = `mermaid-${++mermaidId}`;
        try {
            const { svg } = await mm.render(id, code);
            el.innerHTML = svg;
            appendMermaidActionBtns(el as HTMLElement);
        } catch { /* keep existing render on failure */ }
    }
}

// Lazy Mermaid rendering — only render blocks near the viewport
let mermaidObserver: IntersectionObserver | null = null;

function ensureMermaidObserver(): void {
    if (mermaidObserver) return;
    mermaidObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target as HTMLElement;
            if (!el.classList.contains('mermaid-pending')) continue;
            mermaidObserver!.unobserve(el);
            renderSingleMermaid(el);
        }
    }, { rootMargin: '200px' }); // pre-render 200px before visible
}

function appendMermaidActionBtns(el: HTMLElement): void {
    // Remove existing buttons if present (e.g. re-render)
    el.querySelector('.mermaid-copy-btn')?.remove();
    el.querySelector('.mermaid-save-btn')?.remove();

    const saveBtn = document.createElement('button');
    saveBtn.className = 'mermaid-save-btn';
    saveBtn.type = 'button';
    saveBtn.ariaLabel = 'Save as image';
    saveBtn.title = 'Save';
    saveBtn.innerHTML = ICONS.download;
    el.appendChild(saveBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'mermaid-copy-btn';
    copyBtn.type = 'button';
    copyBtn.ariaLabel = 'Copy source';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = ICONS.copy;
    el.appendChild(copyBtn);
}

async function renderSingleMermaid(el: HTMLElement): Promise<void> {
    el.classList.remove('mermaid-pending');
    const code = el.textContent || '';
    el.dataset.mermaidCode = code;
    const id = `mermaid-${++mermaidId}`;
    try {
        const mm = await getMermaid();
        const { svg } = await mm.render(id, code);
        el.innerHTML = svg;
        el.classList.add('mermaid-rendered');
        appendMermaidActionBtns(el);
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
}

async function renderMermaidBlocks(): Promise<void> {
    const pending = document.querySelectorAll('.mermaid-pending');
    if (!pending.length) return;
    ensureMermaidObserver();
    for (const el of pending) {
        mermaidObserver!.observe(el);
    }
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

// ── Diagram action button event delegation (copy + save) ──
let diagramActionsReady = false;

function ensureDiagramActionDelegation(): void {
    if (diagramActionsReady) return;
    diagramActionsReady = true;

    document.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;

        // ── Copy buttons ──
        const diagCopyBtn = target?.closest('.diagram-copy-btn') as HTMLElement | null;
        if (diagCopyBtn) {
            const container = diagCopyBtn.closest('.diagram-container') as HTMLElement | null;
            if (!container) return;
            let text = '';
            if (container.dataset.widgetHtml) {
                try { text = decodeURIComponent(escape(atob(container.dataset.widgetHtml))); }
                catch { return; }
            } else {
                const svgEl = container.querySelector('svg');
                if (svgEl) text = svgEl.outerHTML;
            }
            if (text) btnFeedback(diagCopyBtn, text, 'copy');
            return;
        }

        const mermaidCopyBtn = target?.closest('.mermaid-copy-btn') as HTMLElement | null;
        if (mermaidCopyBtn) {
            const container = mermaidCopyBtn.closest('.mermaid-container') as HTMLElement | null;
            if (!container) return;
            const code = container.dataset.mermaidCode || '';
            if (code) btnFeedback(mermaidCopyBtn, code, 'copy');
            return;
        }

        // ── Save buttons ──
        const diagSaveBtn = target?.closest('.diagram-save-btn') as HTMLElement | null;
        if (diagSaveBtn) {
            const container = diagSaveBtn.closest('.diagram-container') as HTMLElement | null;
            if (!container) return;
            // Widget: request screenshot via bridge
            if (container.dataset.widgetHtml) {
                const iframe = container.querySelector('iframe') as HTMLIFrameElement | null;
                if (iframe?.contentWindow) {
                    iframe.contentWindow.postMessage({ type: 'jaw-request-screenshot' }, '*');
                    btnFeedback(diagSaveBtn, '', 'save');
                }
                return;
            }
            // SVG: convert to PNG
            const svgEl = container.querySelector('svg');
            if (svgEl) saveSvgAsPng(svgEl, diagSaveBtn);
            return;
        }

        const mermaidSaveBtn = target?.closest('.mermaid-save-btn') as HTMLElement | null;
        if (mermaidSaveBtn) {
            const container = mermaidSaveBtn.closest('.mermaid-container') as HTMLElement | null;
            if (!container) return;
            const svgEl = container.querySelector('svg');
            if (svgEl) saveSvgAsPng(svgEl, mermaidSaveBtn);
            return;
        }
    });
}

function btnFeedback(btn: HTMLElement, text: string, action: 'copy' | 'save'): void {
    const doFeedback = () => {
        const orig = btn.innerHTML;
        btn.innerHTML = ICONS.checkSimple;
        btn.classList.add('copied');
        setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1500);
    };
    if (action === 'copy') {
        navigator.clipboard.writeText(text).then(doFeedback).catch(() => {});
    } else {
        doFeedback();
    }
}

function saveSvgAsPng(svgEl: SVGElement, btn: HTMLElement): void {
    const clone = svgEl.cloneNode(true) as SVGElement;
    // Ensure width/height attributes for canvas rendering
    const bbox = svgEl.getBoundingClientRect();
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(bbox.width));
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(bbox.height));

    const svgData = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
        const scale = 2; // retina
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth * scale;
        canvas.height = img.naturalHeight * scale;
        const ctx = canvas.getContext('2d')!;
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvas.toBlob(blob => {
            if (!blob) return;
            downloadBlob(blob, `diagram-${Date.now()}.png`);
            btnFeedback(btn, '', 'save');
        }, 'image/png');
    };
    img.onerror = () => {
        // Fallback: download as SVG
        URL.revokeObjectURL(url);
        downloadBlob(svgBlob, `diagram-${Date.now()}.svg`);
        btnFeedback(btn, '', 'save');
    };
    img.src = url;
}

function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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
        <button class="diagram-save-btn" type="button"
            aria-label="Save as image" title="Save">${ICONS.download}</button>
        <button class="diagram-copy-btn" type="button"
            aria-label="Copy source" title="Copy">${ICONS.copy}</button>
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
            clone.querySelectorAll('.diagram-zoom-btn, .diagram-copy-btn, .diagram-save-btn').forEach(b => b.remove());
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
    ensureDiagramActionDelegation();

    return html;
}
