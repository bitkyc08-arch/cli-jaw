// 082 §3.6 — single-copy Shiki runtime boundary. This module is the ONLY
// place that dynamically imports @shikijs/* and it is itself only reachable
// through dynamic import. The main thread loads it as a lazy chunk; the
// highlight worker imports the SAME emitted module at runtime via
// `runtimeModuleUrl`, so the grammar/runtime bytes exist exactly once in the
// bundle (the worker file stays a tiny bootstrap).
// Output is RAW inline token HTML (untrusted) — sanitization happens on the
// main thread (workers have no DOM for DOMPurify).
import type { ApprovedLanguage } from './code-block-contract.js';

export const runtimeModuleUrl: string = import.meta.url;

const SENTINELS = Object.freeze({
    foreground: 'var(--syntax-fg)', comment: 'var(--syntax-comment)', keyword: 'var(--syntax-keyword)',
    string: 'var(--syntax-string)', number: 'var(--syntax-number)', type: 'var(--syntax-type)',
    function: 'var(--syntax-function)', operator: 'var(--syntax-operator)', punctuation: 'var(--syntax-punctuation)',
    insert: 'var(--syntax-insert)', delete: 'var(--syntax-delete)',
});
type SyntaxToken = keyof typeof SENTINELS;
const sentinelTheme = { name: 'cli-jaw-sentinel', type: 'dark', fg: SENTINELS.foreground, bg: SENTINELS.foreground, settings: [
    { settings: { foreground: SENTINELS.foreground } },
    { scope: ['comment'], settings: { foreground: SENTINELS.comment } },
    { scope: ['keyword', 'storage'], settings: { foreground: SENTINELS.keyword } },
    { scope: ['string'], settings: { foreground: SENTINELS.string } },
    { scope: ['constant.numeric'], settings: { foreground: SENTINELS.number } },
    { scope: ['entity.name.type', 'storage.type'], settings: { foreground: SENTINELS.type } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: SENTINELS.function } },
    { scope: ['keyword.operator'], settings: { foreground: SENTINELS.operator } },
    { scope: ['punctuation'], settings: { foreground: SENTINELS.punctuation } },
    { scope: ['markup.inserted'], settings: { foreground: SENTINELS.insert } },
    { scope: ['markup.deleted'], settings: { foreground: SENTINELS.delete } },
] };
const grammarLoaders: Record<Exclude<ApprovedLanguage, 'plaintext'>, () => Promise<unknown>> = {
    bash: () => import('@shikijs/langs/bash'), javascript: () => import('@shikijs/langs/javascript'), typescript: () => import('@shikijs/langs/typescript'),
    jsx: () => import('@shikijs/langs/jsx'), tsx: () => import('@shikijs/langs/tsx'), json: () => import('@shikijs/langs/json'),
    python: () => import('@shikijs/langs/python'), css: () => import('@shikijs/langs/css'), html: () => import('@shikijs/langs/html'),
    markdown: () => import('@shikijs/langs/markdown'), yaml: () => import('@shikijs/langs/yaml'), sql: () => import('@shikijs/langs/sql'),
    rust: () => import('@shikijs/langs/rust'), go: () => import('@shikijs/langs/go'), java: () => import('@shikijs/langs/java'),
    cpp: () => import('@shikijs/langs/cpp'), diff: () => import('@shikijs/langs/diff'),
};
type Highlighter = { codeToHtml(code: string, options: unknown): string };
let runtime: Promise<Highlighter> | null = null;
async function getHighlightRuntime(): Promise<Highlighter> {
    runtime ??= (async () => {
        const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, ...modules] = await Promise.all([
            import('@shikijs/core'), import('@shikijs/engine-javascript'), ...Object.values(grammarLoaders).map(load => load()),
        ]);
        const langs = modules.flatMap(module => (module as { default: never[] }).default);
        return createHighlighterCore({ engine: createJavaScriptRegexEngine(), langs, themes: [sentinelTheme as never] }) as unknown as Promise<Highlighter>;
    })();
    return runtime;
}
export function escapeHighlightHtml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
/** RAW inline token html (untrusted — caller must sanitize on the main thread). */
export async function tokenizeCode(code: string, language: ApprovedLanguage): Promise<string> {
    // inline structure: token spans only — CodeBlockSegment chrome owns the
    // single <pre><code> wrapper (082 §3.4), so the runtime must not nest one
    if (language === 'plaintext') return escapeHighlightHtml(code);
    const highlighter = await getHighlightRuntime();
    return highlighter.codeToHtml(code, { lang: language, theme: 'cli-jaw-sentinel', structure: 'inline', transformers: [{
        span(node: { properties?: Record<string, unknown> }) {
            const style = String(node.properties?.['style'] ?? '');
            const token = (Object.entries(SENTINELS).find(([, value]) => style.includes(value))?.[0] ?? 'foreground') as SyntaxToken;
            node.properties = { class: `token syntax-${token}`, 'data-syntax-token': token };
        },
    }] });
}
