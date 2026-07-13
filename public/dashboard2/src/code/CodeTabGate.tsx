// 061 — capability gate. This file is the code/ chunk ENTRY (via index.ts):
// it stays a SMALL chunk (gate + capability client only). The heavy Code
// implementation (CodeTab + adapter + history) loads through the nested
// dynamic import below ONLY when the capability probe reports available.
import { Suspense, lazy, useCallback, useEffect, useState, type JSX } from 'react';
import { fetchCodeCapabilities, type CodeCapabilityState } from './code-capability-client.ts';
import './code-tab.css';

const LazyCodeTabImpl = lazy(() => import('./CodeTab.tsx'));

export interface CodeTabGateProps {
    port: number;
}

const REASON_GUIDANCE: Record<Exclude<CodeCapabilityState['reason'], 'ok'>, { title: string; body: string; retry: boolean }> = {
    missing_binary: {
        title: 'jwc is not installed',
        body: 'Install the external JWC runtime (jaw jwc install) to use Code sessions. Jaw keeps working without it.',
        retry: true,
    },
    acp_unsupported: {
        title: 'jwc version is not ACP-compatible',
        body: 'The installed jwc does not answer the ACP handshake. Update jwc to a build that supports --mode acp.',
        retry: true,
    },
    temporarily_unavailable: {
        title: 'Code runtime is temporarily unavailable',
        body: 'The capability probe could not reach a working jwc runtime. Retry in a moment.',
        retry: true,
    },
};

export function CodeTabGate({ port }: CodeTabGateProps): JSX.Element {
    const [state, setState] = useState<CodeCapabilityState | null>(null);
    const [probing, setProbing] = useState(false);

    const probe = useCallback(async (refresh: boolean) => {
        setProbing(true);
        try {
            setState(await fetchCodeCapabilities(port, { refresh }));
        } catch {
            setState({ available: false, reason: 'temporarily_unavailable' });
        } finally {
            setProbing(false);
        }
    }, [port]);

    useEffect(() => {
        setState(null);
        void probe(false);
    }, [probe]);

    if (!state) {
        return (
            <div className="d2-code-gate" data-testid="code-gate" data-state="probing">
                <span className="d2-spinner" aria-hidden="true" />
                <span>Checking Code runtime…</span>
            </div>
        );
    }

    if (!state.available) {
        const guidance = REASON_GUIDANCE[state.reason === 'ok' ? 'temporarily_unavailable' : state.reason];
        return (
            <div className="d2-code-gate" data-testid="code-gate" data-state={state.reason} role="status">
                <strong>{guidance.title}</strong>
                <p>{guidance.body}</p>
                {guidance.retry ? (
                    <button type="button" disabled={probing} onClick={() => { void probe(true); }}>
                        {probing ? 'Checking…' : 'Retry'}
                    </button>
                ) : null}
            </div>
        );
    }

    return (
        <Suspense
            fallback={(
                <div className="d2-code-gate" data-testid="code-gate" data-state="loading">
                    <span className="d2-spinner" aria-hidden="true" />
                    <span>Loading Code…</span>
                </div>
            )}
        >
            <LazyCodeTabImpl port={port} />
        </Suspense>
    );
}

export default CodeTabGate;
