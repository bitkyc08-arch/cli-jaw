import { useEffect, useId, useMemo, useState } from 'react';
import { preprocessMermaid, sanitizeMermaidForRetry } from '../../../../js/render/mermaid-preprocess';
import { getMermaidInitConfig, isWideMermaidDiagram } from '../../../../js/render/mermaid-config';
import { sanitizeMermaidSvg } from '../../../../js/render/sanitize';

const MAX_RENDERED_MERMAID_CACHE_ENTRIES = 100;

type MermaidApi = {
    initialize(config: Record<string, unknown>): void;
    render(id: string, code: string): Promise<{ svg: string }>;
};

type MermaidBlockProps = {
    code: string;
};

type MermaidState =
    | { status: 'loading'; sourceKey: string }
    | { status: 'ready'; sourceKey: string; svg: string; wide: boolean }
    | { status: 'error'; sourceKey: string; message: string };

type MermaidReadyState = Extract<MermaidState, { status: 'ready' }>;

let mermaidModule: MermaidApi | null = null;
const renderedMermaidCache = new Map<string, MermaidReadyState>();

async function loadMermaid(): Promise<MermaidApi> {
    if (!mermaidModule) {
        const module = await import('mermaid');
        mermaidModule = module.default as MermaidApi;
    }
    mermaidModule.initialize(getMermaidInitConfig());
    return mermaidModule;
}

function getMermaidCacheThemeKey(): string {
    return document.documentElement.getAttribute('data-theme') ?? 'default';
}

function rememberRenderedMermaid(sourceKey: string, state: MermaidReadyState): void {
    renderedMermaidCache.set(sourceKey, state);
    if (renderedMermaidCache.size <= MAX_RENDERED_MERMAID_CACHE_ENTRIES) return;
    const oldest = renderedMermaidCache.keys().next().value;
    if (oldest) renderedMermaidCache.delete(oldest);
}

export function MermaidBlock(props: MermaidBlockProps) {
    const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
    const code = useMemo(() => preprocessMermaid(props.code), [props.code]);
    const themeKey = getMermaidCacheThemeKey();
    const sourceKey = useMemo(() => `${themeKey}\n${code}`, [code, themeKey]);
    const [state, setState] = useState<MermaidState>(
        () => renderedMermaidCache.get(sourceKey) ?? { status: 'loading', sourceKey },
    );

    useEffect(() => {
        let cancelled = false;
        const cached = renderedMermaidCache.get(sourceKey);
        if (cached) {
            setState(cached);
            return () => {
                cancelled = true;
            };
        }

        async function renderDiagram(): Promise<void> {
            setState(current => (
                current.status === 'ready' && current.sourceKey === sourceKey
                    ? current
                    : { status: 'loading', sourceKey }
            ));
            try {
                const mermaid = await loadMermaid();
                const id = `notes-mermaid-${reactId}`;
                let svg: string;
                try {
                    ({ svg } = await mermaid.render(id, code));
                } catch (firstErr: unknown) {
                    const retryCode = sanitizeMermaidForRetry(code);
                    if (!retryCode) throw firstErr;
                    ({ svg } = await mermaid.render(`${id}-retry`, retryCode));
                }
                if (!cancelled) {
                    const ready: MermaidReadyState = {
                        status: 'ready',
                        sourceKey,
                        svg: sanitizeMermaidSvg(svg),
                        wide: isWideMermaidDiagram(code),
                    };
                    rememberRenderedMermaid(sourceKey, ready);
                    setState(ready);
                }
            } catch (err) {
                if (!cancelled) {
                    setState({
                        status: 'error',
                        sourceKey,
                        message: err instanceof Error ? err.message : 'Mermaid render failed',
                    });
                }
            }
        }

        void renderDiagram();
        return () => {
            cancelled = true;
        };
    }, [code, reactId, sourceKey]);

    if (state.status === 'ready') {
        return (
            <div
                className={`notes-mermaid-block is-ready${state.wide ? ' mermaid-type-wide' : ''}`}
                dangerouslySetInnerHTML={{ __html: state.svg }}
            />
        );
    }

    if (state.status === 'error') {
        return (
            <div className="notes-mermaid-block is-error">
                <strong>Mermaid render failed</strong>
                <span>{state.message}</span>
                <pre><code>{props.code}</code></pre>
            </div>
        );
    }

    return (
        <div className="notes-mermaid-block is-loading" role="status" aria-label="Diagram loading">
            Rendering diagram...
        </div>
    );
}
