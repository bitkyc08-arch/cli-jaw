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
import { fixCjkPunctuationBoundary } from './cjk-fix.js';

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

// ── XSS sanitization ──
export function sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true, svg: true, svgFilters: true },
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur'],
        ADD_TAGS: ['use'],
        ADD_ATTR: ['aria-hidden', 'xmlns', 'viewBox'],
    });
}

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
                    <div class="mermaid-error-title">⚠️ ${escapeHtml(t('mermaid.renderFail') || 'Mermaid render failed')}</div>
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

    // Code blocks: highlight.js + mermaid detection
    renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
        if (lang === 'mermaid') {
            return `<div class="mermaid-container mermaid-pending">${escapeHtml(text)}</div>`;
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
        breaks: true,
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

// ── Main export ──
export function renderMarkdown(text: string): string {
    const cleaned = stripOrchestration(text);
    if (!cleaned) return `<em class="text-dim orchestrate-placeholder">${escapeHtml(t('orchestrator.dispatching'))}</em>`;

    const { text: shielded, blocks: mathBlocks } = shieldMath(cleaned);

    ensureMarked();
    const fixed = fixCjkPunctuationBoundary(shielded);
    let html = marked.parse(fixed) as string;
    html = html.replace(/<table/g, '<div class="table-wrapper"><table').replace(/<\/table>/g, '</table></div>');

    html = unshieldMath(html, mathBlocks);
    html = sanitizeHtml(html);

    requestAnimationFrame(() => {
        renderMermaidBlocks();
        rehighlightAll();
    });

    ensureCopyDelegation();

    return html;
}
