// ── Render Helpers ──
// Modular markdown rendering: marked + highlight.js + KaTeX + Mermaid
// All libs bundled via npm imports; mermaid lazy-loaded on first use

import { marked, Renderer } from 'marked';
import { apiJson } from './api.js';
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
import { getDOMPurify } from './sanitizer.js';
import { t } from './features/i18n.js';
import { ICONS } from './icons.js';
import { fixCjkPunctuationBoundary } from './cjk-fix.js';
import {
    SvgBlock, shieldCodeFenceSvg, unshieldCodeFenceSvg,
    extractTopLevelSvg,
} from './diagram/types.js';

const DOMPurify = getDOMPurify();

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

interface MermaidApi {
    initialize(config: Record<string, unknown>): void;
    render(id: string, code: string): Promise<{ svg: string }>;
}

// Lazy mermaid: loaded on first diagram encounter
let mermaidModule: MermaidApi | null = null;

// Serialise all Mermaid render calls — concurrent renders corrupt shared internal state.
let mermaidQueue: Promise<void> = Promise.resolve();

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

async function ensureMermaidLoaded() {
    if (!mermaidModule) {
        const loader = await import('./mermaid-loader.js');
        mermaidModule = loader.loadMermaid();
    }
    return mermaidModule;
}

// Re-apply theme config immediately before every render() call.
// Mermaid's internal config can drift after parse()/render() due to
// directive resets — never cache, always re-initialise.
function applyMermaidTheme() {
    mermaidModule!.initialize({
        startOnLoad: false,
        theme: 'base',
        htmlLabels: false,
        themeVariables: getMermaidThemeVars(),
        securityLevel: 'strict',
        suppressErrorRendering: true,
    });
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
                   'data-jaw-svg', 'data-jaw-kind', 'data-mermaid-code-raw',
                   'href', 'xlink:href'],
    });
}

// ── Orchestration JSON stripping ──
// Only strip JSON blocks that contain orchestration-specific keys, not all JSON blocks
// Require keys unique to orchestration payloads (avoid generic words like "phase")
const ORCH_KEYS = /["'](?:subtasks|employee_config|agent_phases|orchestration_plan)["']\s*:/;
const PROMPT_LEAK_START = /(^|\n)(?:## Approved Plan \((?:authoritative|auto-injected by orchestrator)[^\n]*\)|\[PABCD — [A-Z]:[^\n]*\]|\[PLANNING MODE[^\n]*\]|\[PLAN AUDIT[^\n]*\]|The approved plan is already injected above)/m;

export function stripPromptLeakage(text: string): string {
    const match = PROMPT_LEAK_START.exec(text);
    if (!match || match.index < 0) return text;
    return text.slice(0, match.index).trim();
}

export function stripOrchestration(text: string): string {
    // Strip fenced JSON blocks only if they contain orchestration keys
    let cleaned = text.replace(/```json\n([\s\S]*?)\n```/g, (_match, inner) =>
        ORCH_KEYS.test(inner) ? '' : _match);
    // Strip inline orchestration objects containing subtasks array
    cleaned = cleaned.replace(/\{[^{}]*"subtasks"\s*:\s*\[[\s\S]*?\]\s*\}/g, '').trim();
    return stripPromptLeakage(cleaned);
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

export function unshieldMath(html: string, blocks: MathBlock[], isStreaming = false): string {
    return html.replace(/\x00MATH-(\d+)\x00/g, (_, i) => {
        const block = blocks[Number(i)];
        if (!block) return `<code title="math placeholder error">[math error]</code>`;

        // During streaming: lightweight placeholder, defer KaTeX to finalize
        if (isStreaming) {
            return block.displayMode
                ? `<div class="math-placeholder">${escapeHtml(block.tex)}</div>`
                : `<code class="math-placeholder">${escapeHtml(block.tex)}</code>`;
        }

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
    const rendered = document.querySelectorAll('.mermaid-rendered');
    if (!rendered.length) return;
    mermaidQueue = mermaidQueue.then(async () => {
        const mm = await ensureMermaidLoaded();
        for (const el of rendered) {
            const htmlEl = el as HTMLElement;
            const code = htmlEl.dataset.mermaidCode;
            if (!code || !htmlEl.isConnected) continue;
            const id = `mermaid-${++mermaidId}`;
            try {
                applyMermaidTheme();
                const { svg } = await mm.render(id, code);
                if (!htmlEl.isConnected) continue;
                htmlEl.innerHTML = sanitizeMermaidSvg(svg);
                appendMermaidActionBtns(htmlEl);
                bindDiagramZoom(htmlEl);
            } catch { /* keep existing render on failure */ }
        }
    }).catch(err => {
        console.error('[mermaid:queue] rerender failed, keeping queue alive:', err);
    });
    await mermaidQueue;
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
    el.querySelector('.mermaid-zoom-btn')?.remove();
    el.querySelector('.mermaid-copy-btn')?.remove();
    el.querySelector('.mermaid-save-btn')?.remove();

    const zoomBtn = document.createElement('button');
    zoomBtn.className = 'mermaid-zoom-btn';
    zoomBtn.type = 'button';
    zoomBtn.ariaLabel = 'Expand diagram';
    zoomBtn.title = 'Expand';
    zoomBtn.textContent = '⤢';
    el.appendChild(zoomBtn);

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

function renderMermaidError(el: HTMLElement, code: string, errMsg: string): void {
    el.classList.remove('mermaid-rendered');
    el.innerHTML = `
        <div class="mermaid-error">
            <div class="mermaid-error-title">${ICONS.warning} ${escapeHtml(t('mermaid.renderFail') || 'Mermaid render failed')}</div>
            <div class="mermaid-error-msg">${escapeHtml(errMsg.slice(0, 200))}</div>
            <pre class="mermaid-error-code"><code>${escapeHtml(code)}</code></pre>
        </div>`;
}

async function renderSingleMermaidImpl(el: HTMLElement): Promise<void> {
    if (!el.isConnected) {
        delete el.dataset.mermaidQueued;
        delete el.dataset.mermaidInflight;
        return;
    }
    el.classList.remove('mermaid-pending');
    // Phase 127-F1: raw source lives in data attribute (skeleton DOM has no source text).
    const encoded = el.dataset.mermaidCodeRaw || '';
    const code = encoded ? decodeURIComponent(encoded) : (el.textContent || '');
    el.dataset.mermaidCode = code;
    const id = `mermaid-${++mermaidId}`;
    el.dataset.mermaidInflight = '1';
    try {
        const mm = await ensureMermaidLoaded();
        // Apply theme immediately before render — no intermediate parse()
        // that could reset Mermaid's internal config state.
        applyMermaidTheme();
        const { svg } = await mm.render(id, code);
        if (!el.isConnected) {
            return;
        }
        el.innerHTML = sanitizeMermaidSvg(svg);
        el.classList.add('mermaid-rendered');
        delete el.dataset.mermaidCodeRaw;
        appendMermaidActionBtns(el);
        bindDiagramZoom(el);
    } catch (err: unknown) {
        const errMsg = (err as { message?: string; str?: string })?.message
            || (err as { str?: string })?.str || 'Unknown error';
        renderMermaidError(el, code, errMsg);
    } finally {
        delete el.dataset.mermaidQueued;
        delete el.dataset.mermaidInflight;
    }
}

// Serialise renders to prevent concurrent Mermaid operations from
// corrupting shared internal state (theme config, diagram registry).
function renderSingleMermaid(el: HTMLElement): void {
    // Phase 127-N2: synchronous queued guard prevents duplicate enqueueing when
    // renderMermaidBlocks immediate mode fires repeatedly (e.g. VS onPostRender
    // on every scroll). Class/dataset is set right away so the next pass skips.
    if (el.dataset.mermaidQueued === '1') return;
    el.dataset.mermaidQueued = '1';
    // Phase 127-F6: .catch tail keeps the queue alive after any rejection so
    // one bad render cannot permanently block subsequent diagrams.
    mermaidQueue = mermaidQueue
        .then(() => renderSingleMermaidImpl(el))
        .catch(err => {
            console.error('[mermaid:queue] render failed, keeping queue alive:', err);
        });
}

/**
 * Phase 127-F5: exposed so streaming finalize / virtual-scroll hooks can push
 * new mermaid blocks through the pipeline without waiting for schedulePostRender.
 *
 * @param scope DOM subtree to scan (defaults to whole document)
 * @param opts.immediate if true, render blocks already in (or near) viewport
 *                       right now instead of waiting for the observer.
 */
export async function renderMermaidBlocks(
    scope?: HTMLElement | Document,
    opts: { immediate?: boolean } = {},
): Promise<void> {
    const root = scope || document;
    const pending = root.querySelectorAll<HTMLElement>('.mermaid-pending');
    if (!pending.length) return;
    ensureMermaidObserver();
    for (const el of pending) {
        if (el.dataset.mermaidQueued === '1') continue;   // N2 guard
        if (opts.immediate) {
            const rect = el.getBoundingClientRect();
            const vh = window.innerHeight || document.documentElement.clientHeight;
            const inView = rect.bottom >= -200 && rect.top <= vh + 200;
            if (inView) {
                mermaidObserver!.unobserve(el);
                renderSingleMermaid(el);
                continue;
            }
        }
        mermaidObserver!.observe(el);
    }
}

export function releaseMermaidNodes(scope: HTMLElement): void {
    if (!mermaidObserver) return;
    const selector = [
        '.mermaid-pending',
        '[data-mermaid-queued="1"]',
        '[data-mermaid-inflight="1"]',
    ].join(',');
    const nodes: HTMLElement[] = [];
    if (scope.matches(selector)) nodes.push(scope);
    scope.querySelectorAll<HTMLElement>(selector).forEach((el) => nodes.push(el));
    for (const el of nodes) {
        mermaidObserver.unobserve(el);
        delete el.dataset.mermaidQueued;
        delete el.dataset.mermaidQueuedAt;
        delete el.dataset.mermaidInflight;
        if (!el.classList.contains('mermaid-rendered')
            && (el.dataset.mermaidCodeRaw || el.dataset.mermaidCode)) {
            el.classList.add('mermaid-pending');
        }
    }
}

/**
 * Phase 127-F2: prewarm Mermaid module at idle time so the first diagram's
 * cold-start does not block rendering. Safe to call multiple times.
 */
export function prewarmMermaid(): void {
    if (mermaidModule) return;
    const run = () => { void ensureMermaidLoaded().catch(() => { /* silent */ }); };
    if (typeof (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback === 'function') {
        (window as unknown as { requestIdleCallback: (cb: () => void, opts?: { timeout?: number }) => void })
            .requestIdleCallback(run, { timeout: 2000 });
    } else {
        setTimeout(run, 500);
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
            // Phase 127-F1: store raw source in data attribute, render a skeleton
            // placeholder so users never see raw Mermaid syntax while the diagram loads.
            const encodedCode = encodeURIComponent(text);
            return `<div class="mermaid-container mermaid-pending" data-mermaid-code-raw="${encodedCode}" role="status" aria-label="Diagram loading">
                <div class="mermaid-skeleton">
                    <div class="mermaid-skeleton-spinner"></div>
                    <div class="mermaid-skeleton-text">Rendering diagram…</div>
                </div>
            </div>`;
        }
        // diagram-html: encode as base64, Phase 2 activateWidgets() inflates to sandboxed iframe
        if (lang?.trim().toLowerCase() === 'diagram-html') {
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
export function rehighlightAll(scope?: HTMLElement | Document): void {
    const root = scope || document;
    root.querySelectorAll('.code-block pre code, .code-block-wrapper pre code').forEach(el => {
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

// ── File path linkification (click-to-open in Finder) ──

const FILE_PATH_RE_G = /(?:~\/[^\s)`\]"'<>]+|\/(?:Users|home|tmp|var|opt|private)\/[^\s)`\]"'<>]+)/g;
const TRAILING_PUNCT_RE = /[.,!?:;]+$/;
const LOCAL_FILE_HREF_RE = /^(?:~\/|\/(?:Users|home|tmp|var|opt|private)\/)/;

function isLocalFileHref(href: string): boolean {
    return LOCAL_FILE_HREF_RE.test(href);
}

function openLocalPath(path: string, el?: HTMLElement | null): void {
    if (el) el.classList.add('opening');

    apiJson<{ ok?: boolean; error?: string }>('/api/file/open', 'POST', { path })
        .then(data => {
            el?.classList.remove('opening');
            if (data?.ok !== false) {
                el?.classList.add('opened');
                setTimeout(() => el?.classList.remove('opened'), 1500);
            } else {
                el?.classList.add('open-failed');
                if (el) el.title = data?.error || 'Failed to open';
                setTimeout(() => {
                    el?.classList.remove('open-failed');
                    if (el) el.title = '';
                }, 2000);
            }
        })
        .catch(() => {
            el?.classList.remove('opening');
            el?.classList.add('open-failed');
            setTimeout(() => el?.classList.remove('open-failed'), 2000);
        });
}

/**
 * Walk text nodes inside container, wrap file paths in clickable spans.
 * Idempotent — skips already-linkified paths.
 * Skips: <pre>, <a>, <button>, .file-path-link
 */
export function linkifyFilePaths(container: HTMLElement): void {
    const SKIP_TAGS = new Set(['PRE', 'A', 'BUTTON', 'TEXTAREA', 'INPUT', 'SCRIPT', 'STYLE']);

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            let el = node.parentElement;
            while (el && el !== container) {
                if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
                if (el.classList.contains('file-path-link')) return NodeFilter.FILTER_REJECT;
                if (el.tagName === 'CODE' && el.parentElement?.tagName === 'PRE') {
                    return NodeFilter.FILTER_REJECT;
                }
                el = el.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    // Collect text nodes with matches, grouped by node
    const nodeMatches = new Map<Text, { index: number; raw: string; clean: string }[]>();
    let textNode: Text | null;
    while ((textNode = walker.nextNode() as Text | null)) {
        const text = textNode.textContent || '';
        FILE_PATH_RE_G.lastIndex = 0;
        let m: RegExpExecArray | null;
        const hits: { index: number; raw: string; clean: string }[] = [];
        while ((m = FILE_PATH_RE_G.exec(text))) {
            const raw = m[0];
            const clean = raw.replace(TRAILING_PUNCT_RE, '');
            if (clean.length < 4) continue;
            hits.push({ index: m.index, raw, clean });
        }
        if (hits.length) nodeMatches.set(textNode, hits);
    }

    // Replace each text node once — build full fragment with all matches
    for (const [node, hits] of nodeMatches) {
        const text = node.textContent || '';
        const parent = node.parentNode;
        if (!parent) continue;

        const frag = document.createDocumentFragment();
        let cursor = 0;

        for (const { index, raw, clean } of hits) {
            // Text before this match
            if (index > cursor) {
                frag.appendChild(document.createTextNode(text.slice(cursor, index)));
            }
            // The clickable span
            const span = document.createElement('span');
            span.className = 'file-path-link';
            span.setAttribute('data-file-path', clean);
            span.setAttribute('role', 'button');
            span.setAttribute('tabindex', '0');
            span.textContent = clean;
            frag.appendChild(span);
            // Trailing punctuation that was trimmed
            const trailingPunct = raw.slice(clean.length);
            if (trailingPunct) frag.appendChild(document.createTextNode(trailingPunct));
            cursor = index + raw.length;
        }

        // Remaining text after last match
        if (cursor < text.length) {
            frag.appendChild(document.createTextNode(text.slice(cursor)));
        }

        parent.replaceChild(frag, node);
    }
}

// ── File path click event delegation (one-time setup) ──
let filePathDelegationReady = false;

function ensureFilePathDelegation(): void {
    if (filePathDelegationReady) return;
    filePathDelegationReady = true;

    document.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        const anchor = target?.closest('a') as HTMLAnchorElement | null;
        const href = anchor?.getAttribute('href') || '';
        if (anchor && isLocalFileHref(href)) {
            e.preventDefault();
            anchor.classList.add('file-path-link');
            openLocalPath(href, anchor);
            return;
        }

        const link = target?.closest('.file-path-link') as HTMLElement | null;
        if (!link) return;

        const filePath = link.getAttribute('data-file-path');
        if (!filePath) return;
        openLocalPath(filePath, link);
    });

    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const target = e.target as HTMLElement;
        if (target?.classList.contains('file-path-link')) {
            e.preventDefault();
            target.click();
        }
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

function inlineComputedStyles(original: Element, clone: Element): void {
    const origChildren = original.children;
    const cloneChildren = clone.children;
    const props = ['fill', 'stroke', 'stroke-width', 'color', 'opacity',
        'rx', 'ry', 'font-size', 'font-weight', 'font-family',
        'text-anchor', 'dominant-baseline'];
    for (let i = 0; i < origChildren.length; i++) {
        const oc = origChildren[i];
        const cc = cloneChildren[i];
        if (!oc || !cc) continue;
        const cs = getComputedStyle(oc);
        for (const p of props) {
            const v = cs.getPropertyValue(p);
            if (v) (cc as HTMLElement).style.setProperty(p, v);
        }
        if (oc.children.length) inlineComputedStyles(oc, cc);
    }
}

function saveSvgAsPng(svgEl: SVGElement, btn: HTMLElement): void {
    const clone = svgEl.cloneNode(true) as SVGElement;
    inlineComputedStyles(svgEl, clone);
    const bbox = svgEl.getBoundingClientRect();
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(bbox.width));
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(bbox.height));

    const svgData = new XMLSerializer().serializeToString(clone);
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);
    const img = new Image();
    img.onload = () => {
        const scale = 2; // retina
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth * scale;
        canvas.height = img.naturalHeight * scale;
        const ctx = canvas.getContext('2d')!;
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(blob => {
            if (!blob) return;
            downloadBlob(blob, `diagram-${Date.now()}.png`);
            btnFeedback(btn, '', 'save');
        }, 'image/png');
    };
    img.onerror = () => {
        const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        downloadBlob(svgBlob, `diagram-${Date.now()}.svg`);
        btnFeedback(btn, '', 'save');
    };
    img.src = dataUrl;
}

function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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

export function bindDiagramZoom(scope?: HTMLElement | Document): void {
    const root = scope || document;
    root.querySelectorAll('.diagram-zoom-btn, .mermaid-zoom-btn').forEach(btn => {
        if ((btn as HTMLElement).dataset.bound) return;
        (btn as HTMLElement).dataset.bound = '1';
        btn.addEventListener('click', () => {
            if (btn.closest('.diagram-widget')) return;
            const container = btn.closest('.diagram-container, .mermaid-container');
            if (!container) return;
            const clone = container.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('.diagram-zoom-btn, .mermaid-zoom-btn, .diagram-copy-btn, .diagram-save-btn, .mermaid-copy-btn, .mermaid-save-btn')
                .forEach(b => b.remove());
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

    // Ensure SVGs scale inside overlay: add viewBox if missing, remove fixed dimensions
    overlay.querySelectorAll<SVGSVGElement>('.diagram-overlay-content svg').forEach(svg => {
        if (!svg.getAttribute('viewBox')) {
            const w = svg.getAttribute('width') || svg.getBBox?.()?.width;
            const h = svg.getAttribute('height') || svg.getBBox?.()?.height;
            if (w && h) svg.setAttribute('viewBox', `0 0 ${parseFloat(String(w))} ${parseFloat(String(h))}`);
        }
        svg.removeAttribute('width');
        svg.removeAttribute('height');
    });

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
    html = unshieldMath(html, mathBlocks, isStreaming);

    // 7. Sanitize
    html = sanitizeHtml(html);

    // 8. Unshield SVGs (after sanitize — SVGs sanitized individually in renderSvgBlock)
    html = unshieldSvgBlocks(html, svgBlocks);

    // 9. Post-render async tasks — skip during streaming (deferred to finalize)
    if (!isStreaming) {
        schedulePostRender();
    }

    ensureCopyDelegation();
    ensureDiagramActionDelegation();
    ensureFilePathDelegation();

    return html;
}

// ── Batched post-render scheduler ──
// Coalesces multiple renderMarkdown() calls into a single post-render pass.
let postRenderRAF: number | null = null;
let postRenderTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePostRender(): void {
    // Debounce: coalesce rapid VS render triggers into a single pass
    if (postRenderTimer) clearTimeout(postRenderTimer);
    if (postRenderRAF) { cancelAnimationFrame(postRenderRAF); postRenderRAF = null; }
    postRenderTimer = setTimeout(() => {
        postRenderTimer = null;
        postRenderRAF = requestAnimationFrame(() => {
            postRenderRAF = null;
            renderMermaidBlocks();
            rehighlightAll();
            bindDiagramZoom();
            const msgContainer = document.getElementById('chatMessages');
            if (msgContainer) linkifyFilePaths(msgContainer);
        });
    }, 100);
}

export function cancelPostRender(): void {
    if (postRenderTimer) {
        clearTimeout(postRenderTimer);
        postRenderTimer = null;
    }
    if (postRenderRAF) {
        cancelAnimationFrame(postRenderRAF);
        postRenderRAF = null;
    }
}
