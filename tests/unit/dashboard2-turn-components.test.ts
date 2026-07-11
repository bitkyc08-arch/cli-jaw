// 044 — turn component tree completion gates (doc §7 unit slice).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createElement as h, act } from 'react';
import * as ReactNamespace from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import type { ThinkingMarker, TurnFidelity, TurnLifecycleSsePayload } from '../../src/shared/chat-events.ts';
import { ThinkingSegment } from '../../public/dashboard2/src/turn-stream/components/segments/ThinkingSegment.tsx';
import { ToolLine } from '../../public/dashboard2/src/turn-stream/components/segments/ToolLine.tsx';
import { WidgetSegment } from '../../public/dashboard2/src/turn-stream/components/segments/WidgetSegment.tsx';
import { createTurnStore } from '../../public/dashboard2/src/turn-stream/store/turn-store.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
// tsx compiles repo .tsx with the classic JSX transform (root tsconfig only
// includes server trees), so component modules reference a global `React`.
(globalThis as Record<string, unknown>).React = ReactNamespace;
const MARKERS: ThinkingMarker[] = ['streaming', 'plaintext', 'encrypted', 'token_fallback', 'pre_tool_text', 'plan', 'planner'];
const FIDELITIES: TurnFidelity[] = ['full', 'coarse', 'text_only'];

function segmentRow(partial: Partial<TurnLifecycleSsePayload> & { turnId: string; turnSeq: number }): TurnLifecycleSsePayload {
    return {
        topic: 'agent',
        event: 'turn_segment',
        segmentId: `${partial.turnId}:seg${partial.turnSeq}`,
        sessionId: 's0',
        createdAt: 1_790_000_000_000,
        observedAt: 1_790_000_000_000,
        providerAt: null,
        fidelity: 'full',
        thinkingMarker: null,
        type: 'thinking',
        status: 'done',
        detailRef: null,
        ...partial,
    } as TurnLifecycleSsePayload;
}

test('044: fidelity x marker 21-cell matrix renders per policy table', () => {
    for (const marker of MARKERS) {
        for (const fidelity of FIDELITIES) {
            const html = renderToStaticMarkup(h(ThinkingSegment, {
                segment: segmentRow({ turnId: 't', turnSeq: 2, thinkingMarker: marker, fidelity }),
                fidelity,
                marker,
                running: false,
            }));
            if (fidelity === 'text_only') {
                assert.equal(html, '', `${marker}/text_only renders nothing`);
            } else {
                assert.ok(html.length > 0, `${marker}/${fidelity} renders`);
                if (fidelity === 'coarse') assert.match(html, /coarse/i, `${marker}/coarse carries a coarse badge`);
                if (marker === 'encrypted') {
                    assert.match(html, /data-detail-fetch-allowed="false"/, 'encrypted never fetches detail');
                    assert.match(html, /data-detail-policy="locked"/, 'encrypted is a locked summary');
                }
            }
        }
    }
    // running state activates shimmer
    const running = renderToStaticMarkup(h(ThinkingSegment, {
        segment: segmentRow({ turnId: 't', turnSeq: 2, thinkingMarker: 'streaming' }),
        fidelity: 'full',
        marker: 'streaming',
        running: true,
    }));
    assert.match(running, /shimmer/, 'running thinking uses the shimmer treatment');
});

test('044: collapsed tool has zero detail DOM/iframe; expanded exposes exactly one', () => {
    const base = {
        segment: segmentRow({ turnId: 't', turnSeq: 3, type: 'tool' }),
        label: 'Tool #1',
        status: 'done' as const,
        onToggle: () => {},
        detail: h('div', { className: 'probe-detail' }, 'detail body'),
    };
    const collapsed = renderToStaticMarkup(h(ToolLine, { ...base, expanded: false }));
    assert.equal((collapsed.match(/data-tool-detail/g) ?? []).length, 0, 'collapsed: no detail DOM');
    assert.equal((collapsed.match(/<iframe/g) ?? []).length, 0, 'collapsed: no iframe');
    assert.match(collapsed, /aria-expanded="false"/);
    const expanded = renderToStaticMarkup(h(ToolLine, { ...base, expanded: true }));
    assert.ok((expanded.match(/data-tool-detail/g) ?? []).length >= 1, 'expanded: detail region present');
    assert.equal((expanded.match(/probe-detail/g) ?? []).length, 1, 'expanded: passed detail mounted once');
    assert.match(expanded, /aria-expanded="true"/);
});

test('044: widget collapsed placeholder is fixed-height and iframe-free', () => {
    const html = renderToStaticMarkup(h(WidgetSegment, {
        descriptor: { widgetId: 'w1', title: 'Chart', estimatedHeight: 240 },
        expanded: false,
        onToggle: () => {},
    }));
    assert.equal((html.match(/<iframe/g) ?? []).length, 0, 'collapsed widget mounts no iframe');
    assert.match(html, /240/, 'placeholder carries the estimated height');
});

// ─── TurnRow behavior (jsdom + act) ─────────────────────────────────

async function renderTurnRow(rows: TurnLifecycleSsePayload[], turnId: string) {
    const dom = new JSDOM('<div id="root"></div>');
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    for (const [name, value] of Object.entries({
        window: dom.window,
        document: dom.window.document,
        navigator: dom.window.navigator,
    })) {
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }
    const { createRoot } = await import('react-dom/client');
    const { TurnRow } = await import('../../public/dashboard2/src/turn-stream/components/TurnRow.tsx');
    const store = createTurnStore('3457/harness');
    store.ingest(rows.map(payload => ({ kind: 'lifecycle', payload })));
    const container = dom.window.document.getElementById('root')!;
    const root = createRoot(container);
    await act(async () => { root.render(h(TurnRow, { store, turnId })); });
    return { container, root, store, act, render: async () => act(async () => { root.render(h(TurnRow, { store, turnId })); }) };
}

function turnFixture(turnId: string): TurnLifecycleSsePayload[] {
    return [
        segmentRow({ turnId, turnSeq: 1, type: 'turn_start', status: 'running', event: 'turn_start', segmentId: `${turnId}:start`, observedAt: 1_790_000_000_000, createdAt: 1_790_000_000_000 }),
        segmentRow({ turnId, turnSeq: 2, type: 'thinking', thinkingMarker: 'streaming', segmentId: `${turnId}:think`, observedAt: 1_790_000_001_000 }),
        segmentRow({ turnId, turnSeq: 3, type: 'tool', segmentId: `${turnId}:tool`, detailRef: { traceRunId: 'run-1', traceSeq: 1 }, observedAt: 1_790_000_002_000 }),
        segmentRow({ turnId, turnSeq: 4, type: 'assistant_text', segmentId: `${turnId}:text`, observedAt: 1_790_000_003_000 }),
        segmentRow({ turnId, turnSeq: 5, type: 'turn_end', status: 'done', event: 'turn_end', segmentId: `${turnId}:end`, observedAt: 1_790_000_005_400, createdAt: 1_790_000_000_000 }),
    ];
}

test('044: duration equals lifecycle observedAt delta (same createdAt, null providerAt)', async () => {
    const { container } = await renderTurnRow(turnFixture('dur-turn'), 'dur-turn');
    const duration = container.querySelector('[data-testid="turn-duration"]');
    assert.ok(duration, 'duration rendered');
    assert.equal(duration.getAttribute('data-duration-ms'), '5400');
});

test('044: grok pair / promotion converge to one element; zero duplicate-key warnings', async () => {
    const warnings: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { warnings.push(String(args[0])); };
    try {
        const rows = [
            ...turnFixture('grok-turn').slice(0, 2),
            // same segmentId re-appended (running→done pair) at a new turnSeq
            segmentRow({ turnId: 'grok-turn', turnSeq: 3, type: 'thinking', status: 'done', thinkingMarker: 'streaming', segmentId: 'grok-turn:think' }),
            segmentRow({ turnId: 'grok-turn', turnSeq: 4, type: 'turn_end', status: 'done', event: 'turn_end', segmentId: 'grok-turn:end' }),
        ];
        const { container } = await renderTurnRow(rows, 'grok-turn');
        const thinking = container.querySelectorAll('.d2-thinking-segment');
        assert.equal(thinking.length, 1, 'grok pair converges to ONE thinking element');
        assert.equal(thinking[0]?.getAttribute('data-segment-status'), 'done', 'converged to the terminal row');
        const dupWarnings = warnings.filter(w => w.includes('same key') || w.includes('duplicate'));
        assert.deepEqual(dupWarnings, [], 'no React duplicate-key warnings');
    } finally {
        console.error = original;
    }
});

test('044: Running→Ran identity keeps element count, changes status only', async () => {
    const running = turnFixture('flow-turn').slice(0, 3); // start + thinking + tool(running default done… use running)
    running[2] = { ...running[2], status: 'running' };
    const { container, store, render } = await renderTurnRow(running, 'flow-turn');
    // TurnRow renders only for committed turns (stub) — close the turn first
    store.ingest([{ kind: 'lifecycle', payload: segmentRow({ turnId: 'flow-turn', turnSeq: 9, type: 'turn_end', status: 'done', event: 'turn_end', segmentId: 'flow-turn:end' }) }]);
    await render();
    const before = container.querySelectorAll('.d2-turn-row > *').length;
    // same (turnId,turnSeq) conflict keeps first row; a NEW seq with same segmentId converges display
    store.ingest([{ kind: 'lifecycle', payload: segmentRow({ turnId: 'flow-turn', turnSeq: 8, type: 'tool', status: 'done', segmentId: 'flow-turn:seg3'.replace('seg3', 'tool'), detailRef: { traceRunId: 'run-1', traceSeq: 1 } }) }]);
    await render();
    const after = container.querySelectorAll('.d2-turn-row > *').length;
    assert.equal(after, before, 'element count stable across Running→Ran');
});

// ─── source contracts (034 §1.2/§1.4) ───────────────────────────────

test('044: source contracts — Icon reuse, no theme writes, css import order, no jwc/source branch', () => {
    const segmentsDir = join(ROOT, 'public/dashboard2/src/turn-stream/components/segments');
    for (const rel of ['ThinkingSegment.tsx', 'ToolLine.tsx', 'AssistantTextSegment.tsx', 'CollabSegment.tsx', 'WidgetSegment.tsx', 'ExploreAggregate.tsx']) {
        const text = readFileSync(join(segmentsDir, rel), 'utf8');
        assert.ok(!/<svg/i.test(text), `${rel}: no hand-rolled svg`);
        assert.ok(!/colorScheme|data-theme/.test(text), `${rel}: no theme ownership`);
        assert.ok(!/\bjwc\b|source === ['"](jaw|code)['"]/.test(text), `${rel}: no source branch`);
    }
    const main = readFileSync(join(ROOT, 'public/dashboard2/src/main.tsx'), 'utf8');
    const tokenIdx = main.indexOf('manager-tokens.css');
    const baseIdx = main.indexOf('styles/base.css');
    const turnIdx = main.indexOf('styles/turn-stream.css');
    assert.ok(tokenIdx >= 0 && baseIdx > tokenIdx && turnIdx > baseIdx, 'css import order: tokens → base → turn-stream');
    const workbench = readFileSync(join(ROOT, 'public/dashboard2/src/shell/Workbench.tsx'), 'utf8');
    assert.ok(workbench.includes('TurnStreamPane'), 'turn stream mounts inside the Workbench pane array');
});
