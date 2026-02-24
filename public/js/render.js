// ── Render Helpers ──
// Modular markdown rendering: marked.js + highlight.js + KaTeX + Mermaid
// All libs loaded via CDN (defer), graceful fallback if unavailable

export function escapeHtml(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Orchestration JSON stripping ──
function stripOrchestration(text) {
    let cleaned = text.replace(/```json\n[\s\S]*?\n```/g, '');
    cleaned = cleaned.replace(/\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*?\]\s*\}/g, '').trim();
    return cleaned;
}

// ── KaTeX inline/block math ──
function renderMath(html) {
    if (typeof katex === 'undefined') return html;
    // Block math: $$...$$
    html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
        try {
            return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false });
        } catch { return `<code>${escapeHtml(tex)}</code>`; }
    });
    // Inline math: $...$  (avoid matching currency like $10)
    html = html.replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g, (_, tex) => {
        try {
            return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false });
        } catch { return `<code>${escapeHtml(tex)}</code>`; }
    });
    return html;
}

// ── Mermaid deferred rendering ──
let mermaidId = 0;

function renderMermaidBlocks() {
    if (typeof mermaid === 'undefined') return;
    document.querySelectorAll('.mermaid-pending').forEach(async (el) => {
        el.classList.remove('mermaid-pending');
        const code = el.textContent;
        const id = `mermaid-${++mermaidId}`;
        try {
            const { svg } = await mermaid.render(id, code);
            el.innerHTML = svg;
            el.classList.add('mermaid-rendered');
        } catch (err) {
            const errMsg = err?.message || err?.str || 'Unknown error';
            el.innerHTML = `
                <div style="border:1px solid #ef4444;border-radius:6px;padding:8px;margin:4px 0">
                    <div style="color:#ef4444;font-size:11px;margin-bottom:4px">⚠️ Mermaid 렌더링 실패</div>
                    <div style="color:#fbbf24;font-size:10px;margin-bottom:6px">${escapeHtml(errMsg.slice(0, 200))}</div>
                    <pre style="margin:0;font-size:11px;overflow-x:auto"><code>${escapeHtml(code)}</code></pre>
                </div>`;
        }
    });
}

// ── marked.js configuration ──
let markedReady = false;

function ensureMarked() {
    if (markedReady) return true;
    if (typeof marked === 'undefined') return false;

    const renderer = new marked.Renderer();

    // Code blocks: highlight.js + mermaid detection
    renderer.code = function ({ text, lang }) {
        // Mermaid
        if (lang === 'mermaid') {
            return `<div class="mermaid-container mermaid-pending">${escapeHtml(text)}</div>`;
        }
        // Highlight.js
        let highlighted = escapeHtml(text);
        if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            try {
                highlighted = hljs.highlight(text, { language: lang }).value;
            } catch { /* fallback to escaped */ }
        } else if (typeof hljs !== 'undefined') {
            try {
                highlighted = hljs.highlightAuto(text).value;
            } catch { /* fallback */ }
        }
        const label = lang ? `<span class="code-lang-label">${escapeHtml(lang)}</span>` : '';
        return `<div class="code-block-wrapper">${label}<pre><code class="hljs${lang ? ` language-${escapeHtml(lang)}` : ''}">${highlighted}</code></pre></div>`;
    };

    marked.setOptions({
        renderer,
        gfm: true,
        breaks: true,
    });

    // Init mermaid
    if (typeof window.mermaid !== 'undefined') {
        window.mermaid.initialize({
            startOnLoad: false,
            theme: 'dark',
            securityLevel: 'loose',
        });
    }

    markedReady = true;
    return true;
}

// ── Fallback regex renderer (CDN 실패 시) ──
function renderFallback(text) {
    return escapeHtml(text)
        .replace(/`{3,}(\w*)\n([\s\S]*?)`{3,}/g, '<pre><code>$2</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^### (.+)$/gm, '<div style="font-weight:700;margin:8px 0 4px">$1</div>')
        .replace(/^## (.+)$/gm, '<div style="font-weight:700;font-size:14px;margin:10px 0 4px">$1</div>')
        .replace(/^# (.+)$/gm, '<div style="font-weight:700;font-size:16px;margin:12px 0 4px">$1</div>')
        .replace(/\n/g, '<br>');
}

// ── Main export ──
export function renderMarkdown(text) {
    const cleaned = stripOrchestration(text);
    if (!cleaned) return '<em style="color:var(--text-dim)">🎯 작업 분배 중...</em>';

    let html;
    if (ensureMarked()) {
        html = marked.parse(cleaned);
    } else {
        html = renderFallback(cleaned);
    }

    // KaTeX math
    html = renderMath(html);

    // Schedule mermaid rendering (needs DOM)
    requestAnimationFrame(renderMermaidBlocks);

    return html;
}
