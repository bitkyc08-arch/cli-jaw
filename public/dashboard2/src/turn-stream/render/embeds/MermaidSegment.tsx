import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { RenderIdentity } from '../parse-coalescer.js';
import { invalidateHeights } from '../render-cache.js';
import { sanitizedHtmlProps, type SanitizedHtml } from '../sanitize-policy.js';
import { renderMermaid, type MermaidRenderResult } from './mermaid-runtime.js';
import type { ResolvedTheme } from './mermaid-config.js';

export interface MermaidSegmentProps {
    source: string;
    identity?: RenderIdentity;
    scrollRoot?: Element | null;
}

type ViewState = { status: 'skeleton' | 'queued' } | MermaidRenderResult;

function resolvedTheme(): ResolvedTheme {
    const selected = document.documentElement.getAttribute('data-theme');
    if (selected === 'light' || selected === 'dark') return selected;
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function MermaidSegment({ source, identity, scrollRoot = null }: MermaidSegmentProps): ReactElement {
    const host = useRef<HTMLDivElement>(null);
    const generation = useRef(0);
    const [theme, setTheme] = useState<ResolvedTheme>(typeof document === 'undefined' ? 'dark' : resolvedTheme());
    const [visible, setVisible] = useState(false);
    const [state, setState] = useState<ViewState>({ status: 'skeleton' });
    const invalidate = useCallback(() => {
        if (identity) invalidateHeights({ scopeKey: identity.scopeKey, turnId: identity.turnId });
    }, [identity?.scopeKey, identity?.turnId]);

    useEffect(() => {
        const node = host.current;
        if (!node) return;
        if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
        }, { root: scrollRoot, rootMargin: '600px 0px' });
        observer.observe(node);
        return () => observer.disconnect();
    }, [scrollRoot, source]);

    useEffect(() => {
        const observer = new MutationObserver(() => {
            const next = resolvedTheme();
            setTheme(current => {
                if (next === current) return current;
                generation.current += 1; setState({ status: 'queued' }); return next;
            });
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => observer.disconnect();
    }, []);

    const requestRender = useCallback((explicit = false) => {
        if (!visible) return;
        const mine = ++generation.current;
        const requestTheme = theme;
        setState({ status: 'queued' });
        void renderMermaid({
            source, resolvedTheme: requestTheme, generation: mine, explicit,
            isCurrent: (candidate, candidateTheme) => generation.current === candidate && theme === candidateTheme,
        }).then(result => {
            if (result.status === 'stale' || generation.current !== mine) return;
            setState(result); invalidate();
        });
    }, [invalidate, source, theme, visible]);

    useEffect(() => { requestRender(); return () => { generation.current += 1; }; }, [requestRender]);

    let content: ReactElement;
    if (state.status === 'ready') {
        content = <div className="d2-mermaid__svg" dangerouslySetInnerHTML={sanitizedHtmlProps(state.svg as SanitizedHtml)} />;
    } else if (state.status === 'error') {
        content = <div className="d2-mermaid__error" role="alert"><p>{state.error}</p><pre>{source}</pre><button type="button" onClick={() => requestRender(true)}>Retry</button></div>;
    } else if (state.status === 'oversize') {
        content = <div className="d2-mermaid__error" role="status"><p>{state.notice}</p><pre>{source}</pre><button type="button" onClick={() => requestRender(true)}>Render diagram</button></div>;
    } else {
        content = <div className="d2-mermaid__skeleton" role="status" aria-label={state.status === 'queued' ? 'Diagram queued' : 'Diagram loading'} />;
    }
    return <div ref={host} className="d2-mermaid" data-state={state.status}>{content}</div>;
}
