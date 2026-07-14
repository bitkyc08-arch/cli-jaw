import type { SanitizedHtml } from './sanitize-policy.js';

export const approvedGrammarInventory = Object.freeze([
    'plaintext', 'bash', 'javascript', 'typescript', 'jsx', 'tsx', 'json', 'python', 'css',
    'html', 'markdown', 'yaml', 'sql', 'rust', 'go', 'java', 'cpp', 'diff',
] as const);

export type ApprovedLanguage = typeof approvedGrammarInventory[number];
export const languageAliases: Readonly<Record<string, ApprovedLanguage>> = Object.freeze({
    js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', yml: 'yaml', rs: 'rust',
    c: 'cpp', text: 'plaintext', plaintext: 'plaintext', 'text/plaintext': 'plaintext',
});

export interface HighlightRequest {
    code: string; codeHash: string; language: string; streaming: boolean; openFence: boolean;
    generation: number; priority: 'visible' | 'manual' | 'prewarm';
}
export type PlainHighlight = { readonly kind: 'plain'; readonly source: string };
export interface HighlightResult {
    html: SanitizedHtml | PlainHighlight; language: string; cacheKey: string;
    generation: number; error?: string;
}
export type CodeBlockUiState =
    | { readonly kind: 'plain' }
    | { readonly kind: 'highlighting' }
    | { readonly kind: 'highlighted'; readonly html: SanitizedHtml }
    | { readonly kind: 'manual' }
    | { readonly kind: 'oversize'; readonly sizeKiB: number }
    | { readonly kind: 'error'; readonly message: string };
export interface CodeBlockModel {
    source: string; language: string; openFence: boolean; streaming: boolean;
    wrap: 'wrap' | 'nowrap'; copy: 'idle' | 'copied'; ui: CodeBlockUiState;
}

export function normalizeLanguage(language: string): string {
    const normalized = language.trim().toLowerCase().replace(/^language-/, '');
    return (languageAliases[normalized] ?? normalized) || 'plaintext';
}
export function isApprovedLanguage(language: string): language is ApprovedLanguage {
    return (approvedGrammarInventory as readonly string[]).includes(language);
}
