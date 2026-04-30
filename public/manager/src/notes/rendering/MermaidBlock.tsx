import { useEffect, useId, useState } from 'react';

type MermaidApi = {
    initialize(config: Record<string, unknown>): void;
    render(id: string, code: string): Promise<{ svg: string }>;
};

type MermaidBlockProps = {
    code: string;
};

type MermaidState =
    | { status: 'loading' }
    | { status: 'ready'; svg: string }
    | { status: 'error'; message: string };

let mermaidModule: MermaidApi | null = null;

async function loadMermaid(): Promise<MermaidApi> {
    if (!mermaidModule) {
        const module = await import('mermaid');
        const mermaid = module.default as MermaidApi;
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
        });
        mermaidModule = mermaid;
    }
    return mermaidModule;
}

export function MermaidBlock(props: MermaidBlockProps) {
    const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
    const [state, setState] = useState<MermaidState>({ status: 'loading' });

    useEffect(() => {
        let cancelled = false;

        async function renderDiagram(): Promise<void> {
            setState({ status: 'loading' });
            try {
                const mermaid = await loadMermaid();
                const { svg } = await mermaid.render(`notes-mermaid-${reactId}`, props.code);
                if (!cancelled) setState({ status: 'ready', svg });
            } catch (err) {
                if (!cancelled) {
                    setState({
                        status: 'error',
                        message: err instanceof Error ? err.message : 'Mermaid render failed',
                    });
                }
            }
        }

        void renderDiagram();
        return () => {
            cancelled = true;
        };
    }, [props.code, reactId]);

    if (state.status === 'ready') {
        return (
            <div
                className="notes-mermaid-block is-ready"
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
