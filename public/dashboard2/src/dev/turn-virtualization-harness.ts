// 044 — dev/test-only harness: mounts the REAL TurnStreamViewport (production
// component tree) against a fixture-fed TurnStore for the browser gate.
// Never statically imported by the app; excluded from production bundles.
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { SegmentedMessageItem, TurnLifecycleSsePayload } from '../../../../src/shared/chat-events.ts';
import { ManagerPreferencesProvider, type PreferencesRegistryClient } from '../providers/preferences-provider.tsx';
import { TurnStreamViewport } from '../turn-stream/components/TurnStreamViewport.tsx';
import { createTurnStore, type TurnStore } from '../turn-stream/store/turn-store.ts';

if (import.meta.env.PROD) {
    throw new Error('turn-virtualization-harness is dev/test-only');
}

export interface VirtualizationHarness {
    store: TurnStore;
    ingestLifecycle(events: TurnLifecycleSsePayload[]): void;
    ingestHistory(messages: SegmentedMessageItem[]): void;
    mountedRowCount(): number;
}

declare global {
    interface Window { __jawTurnVirtHarness?: VirtualizationHarness }
}

export function mountTurnVirtualizationHarness(): VirtualizationHarness {
    const style = document.createElement('style');
    style.textContent = `
        html,body{margin:0;background:#0d0f12;color:#e8eaed}
        #d2virt-host{position:fixed;inset:0;display:flex}
        .d2-turn-pane,.d2-turn-scroll{flex:1;min-height:0}
        .d2-turn-scroll{overflow-y:auto;contain:strict;height:100vh}
        .d2-turn-transcript{max-width:700px;margin:0 auto;width:100%;position:relative}
        .d2-turn-slot{position:absolute;top:0;left:0;width:100%}
    `;
    document.head.appendChild(style);
    const host = document.createElement('div');
    host.id = 'd2virt-host';
    document.body.appendChild(host);
    const store = createTurnStore('3457/harness');
    // R1: viewport subtree now consumes usePreferences() (locale copy) — the
    // harness must provide the provider with a stub registry client
    const client: PreferencesRegistryClient = {
        async load() {
            return { registry: { ui: { uiTheme: 'auto', locale: 'ko', dashboardShortcutsEnabled: true, dashboardShortcutKeymap: 'default' } } as never, status: {} };
        },
        async patch() {
            return { registry: { ui: { uiTheme: 'auto', locale: 'ko', dashboardShortcutsEnabled: true, dashboardShortcutKeymap: 'default' } } as never, status: {} };
        },
    };
    createRoot(host).render(h(ManagerPreferencesProvider, { client }, h(TurnStreamViewport, { store })));
    const harness: VirtualizationHarness = {
        store,
        ingestLifecycle(events) {
            store.ingest(events.map(payload => ({ kind: 'lifecycle', payload })));
        },
        ingestHistory(messages) {
            store.ingest({ kind: 'history_page', messages });
        },
        mountedRowCount() {
            return document.querySelectorAll('.d2-turn-slot').length;
        },
    };
    window.__jawTurnVirtHarness = harness;
    return harness;
}
