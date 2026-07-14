import { Fragment, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { getHighlightService } from '../render/highlight-service.ts';

const CLASS = /^(token( syntax-[\w-]+)?|language-[\w-]+)$/;
export function projectHighlightHtml(html: string, parser: DOMParser = new DOMParser()): ReactNode[] {
    const document = parser.parseFromString(html, 'text/html'); let key = 0;
    const project = (node: Node): ReactNode => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
        if (!(node instanceof Element)) return null;
        const tag = node.tagName.toLowerCase();
        if (!['pre', 'code', 'span', 'br'].includes(tag)) return null;
        if (tag === 'br') return <br key={key++} />;
        const className = node.getAttribute('class');
        const safeClass = className?.split(/\s+/).filter(value => CLASS.test(value)).join(' ') || undefined;
        const token = node.getAttribute('data-syntax-token');
        const props = { key: key++, ...(safeClass ? { className: safeClass } : {}), ...(token ? { 'data-syntax-token': token } : {}) };
        return tag === 'pre' ? <pre {...props}>{[...node.childNodes].map(project)}</pre> : tag === 'code' ? <code {...props}>{[...node.childNodes].map(project)}</code> : <span {...props}>{[...node.childNodes].map(project)}</span>;
    };
    return [...document.body.childNodes].map(project);
}
export function ToolDetailCodeBlock({ code, language, kind }: { code: string; language?: string; kind?: string }): ReactElement {
    const explicit = Boolean(language || kind === 'json' || kind === 'diff' || kind === 'source');
    const [html, setHtml] = useState<string>(); const hash = useMemo(() => `${code.length}:${code.slice(0, 32)}`, [code]);
    useEffect(() => { if (!explicit) { setHtml(undefined); return; } const handle = getHighlightService().request(`tool-detail:${hash}`, { code, codeHash: hash, language: language ?? kind ?? '', streaming: false, openFence: false, generation: 1, priority: 'visible' }); void handle.promise.then(result => setHtml(typeof result.html === 'string' ? result.html : undefined)); return () => handle.cancel(); }, [code, explicit, hash, kind, language]);
    return <code>{html ? <Fragment>{projectHighlightHtml(html)}</Fragment> : code}</code>;
}
