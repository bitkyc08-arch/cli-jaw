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

const LANGUAGES: Array<[string, Parameters<typeof hljs.registerLanguage>[1]]> = [
    ['javascript', javascript],
    ['js', javascript],
    ['typescript', typescript],
    ['ts', typescript],
    ['python', python],
    ['py', python],
    ['bash', bash],
    ['shell', shell],
    ['sh', shell],
    ['json', json],
    ['css', css],
    ['xml', xml],
    ['html', xml],
    ['markdown', markdown],
    ['md', markdown],
    ['yaml', yaml],
    ['yml', yaml],
    ['sql', sql],
    ['rust', rust],
    ['rs', rust],
    ['go', go],
    ['java', java],
    ['cpp', cpp],
    ['c', cpp],
    ['diff', diff],
    ['plaintext', plaintext],
    ['text', plaintext],
];

let registered = false;

function registerHighlightLanguages(): void {
    if (registered) return;
    LANGUAGES.forEach(([name, language]) => {
        hljs.registerLanguage(name, language);
    });
    registered = true;
}

export type HighlightResult = {
    html: string;
    language: string;
    highlighted: boolean;
};

export function normalizeCodeLanguage(language?: string): string {
    return language?.trim().toLowerCase().replace(/^language-/, '') || 'text';
}

export function highlightCode(code: string, language?: string): HighlightResult {
    registerHighlightLanguages();
    const normalized = normalizeCodeLanguage(language);
    if (!hljs.getLanguage(normalized)) {
        return {
            html: code.replace(/[&<>"']/g, value => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[value] ?? value),
            language: normalized,
            highlighted: false,
        };
    }

    try {
        return {
            html: hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value,
            language: normalized,
            highlighted: true,
        };
    } catch {
        return {
            html: code.replace(/[&<>"']/g, value => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[value] ?? value),
            language: normalized,
            highlighted: false,
        };
    }
}
