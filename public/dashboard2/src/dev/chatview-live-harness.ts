// 045 — dev/test-only harness: real TurnStreamViewport + LiveTurnTail against
// a fixture-fed store, for the live-tail browser gate. Not in prod bundles.
// (production-path parity: body chunks flow through the 041 normalizer and
// the 045 stream scheduler, exactly like ChatView's subscribeAgentBody wiring)
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentOutputSsePayload, TurnLifecycleSsePayload } from '../../../../src/shared/chat-events.ts';
import { TurnStreamViewport } from '../turn-stream/components/TurnStreamViewport.tsx';
import { LiveTurnTail } from '../turn-stream/live/LiveTurnTail.tsx';
import { createStreamScheduler } from '../turn-stream/live/stream-scheduler.ts';
import { normalizeAgentOutput } from '../turn-stream/hydrate.ts';
import type { TurnStreamAction } from '../turn-stream/types.ts';
import { createTurnStore, type TurnStore } from '../turn-stream/store/turn-store.ts';

if (import.meta.env.PROD) {
    throw new Error('chatview-live-harness is dev/test-only');
}

export interface LiveHarness {
    store: TurnStore;
    ingestLifecycle(events: TurnLifecycleSsePayload[]): void;
    pushBody(traceRunId: string, text: string, textLen: number): void;
    counts(): { liveArticles: number; committedRows: number; liveTailText: string };
}

declare global {
    interface Window { __jawLiveHarness?: LiveHarness }
}

export function mountChatViewLiveHarness(): LiveHarness {
    const style = document.createElement('style');
    style.textContent = `
        html,body{margin:0;background:#0d0f12;color:#e8eaed}
        #d2live-host{position:fixed;inset:0;display:flex}
        .d2-turn-scroll{flex:1;overflow-y:auto;height:100vh}
        .d2-turn-transcript{max-width:700px;margin:0 auto;width:100%;position:relative}
        .d2-turn-slot{position:absolute;top:0;left:0;width:100%}
        .d2-live-tail{max-width:700px;margin:0 auto}
    `;
    document.head.appendChild(style);
    const host = document.createElement('div');
    host.id = 'd2live-host';
    document.body.appendChild(host);
    const store = createTurnStore('3457/live-harness');
    createRoot(host).render(
        h(TurnStreamViewport, { store, tail: h(LiveTurnTail, { store }) }),
    );
    const pending: TurnStreamAction[] = [];
    const scheduler = createStreamScheduler(() => {
        if (pending.length) store.ingest(pending.splice(0, pending.length));
    });
    const harness: LiveHarness = {
        store,
        ingestLifecycle(events) {
            store.ingest(events.map(payload => ({ kind: 'lifecycle', payload })));
        },
        pushBody(traceRunId, text, textLen) {
            const payload: AgentOutputSsePayload = {
                topic: 'agent', event: 'agent_output', traceRunId, text, textLen,
            };
            pending.push(normalizeAgentOutput(payload));
            scheduler.push(text);
        },
        counts() {
            return {
                liveArticles: document.querySelectorAll('[data-live="1"]').length,
                committedRows: document.querySelectorAll('.d2-turn-row').length,
                liveTailText: (document.querySelector('.d2-live-tail')?.textContent ?? ''),
            };
        },
    };
    window.__jawLiveHarness = harness;
    return harness;
}
