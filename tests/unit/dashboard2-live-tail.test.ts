import * as R from 'react';
(globalThis as any).React = R;

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TurnSegment } from '../../src/shared/chat-events.ts';
import { MarkdownSegment } from '../../public/dashboard2/src/turn-stream/components/MarkdownSegment.tsx';
import {
    prepareFoldSnapshot,
    reconcileFoldFrame,
} from '../../public/dashboard2/src/turn-stream/live/fold-live-turn.ts';
import { createStreamScheduler } from '../../public/dashboard2/src/turn-stream/live/stream-scheduler.ts';

function segment(overrides: Partial<TurnSegment> = {}): TurnSegment {
    return {
        turnId: 'turn-1', turnSeq: 1, segmentId: 'segment-1', sessionId: 'session-1',
        createdAt: 1, observedAt: 1, providerAt: null, fidelity: 'full', thinkingMarker: null,
        type: 'assistant_text', status: 'running', detailRef: null, ...overrides,
    };
}

test('stream scheduler flushes at most once per frame', () => {
    const frames: Array<() => void> = [];
    const flushed: Array<[string, readonly string[]]> = [];
    const scheduler = createStreamScheduler((key, chunks) => flushed.push([key, [...chunks]]), {
        raf: callback => { frames.push(callback); return frames.length; },
        now: () => 0,
    });
    scheduler.beginTurn('turn-1');
    scheduler.push('turn-1', 'a');
    scheduler.push('turn-1', 'b');
    assert.equal(frames.length, 1);
    frames.shift()?.();
    assert.deepEqual(flushed, [['turn-1', ['a', 'b']]]);
    assert.deepEqual(scheduler.stats('turn-1'), {
        receivedChars: 2, flushCount: 1, maxBatch: 2,
    });
});

test('stream scheduler preserves every 20Hz chunk across a fake 60 second run', () => {
    let time = 0;
    const frames: Array<() => void> = [];
    const output: string[] = [];
    const scheduler = createStreamScheduler((_key, chunks) => output.push(...chunks), {
        raf: callback => { frames.push(callback); return frames.length; },
        now: () => time,
    });
    const expected: string[] = [];
    for (let index = 0; index < 20 * 60; index++) {
        const chunk = `[${index}]`;
        expected.push(chunk);
        scheduler.push('turn-1', chunk);
        time += 50;
        const frame = frames.shift();
        frame?.();
    }
    scheduler.flushTurn('turn-1');
    assert.deepEqual(output, expected);
    assert.equal(new Set(output).size, expected.length);
});

test('keyed scheduler resets near-1MiB turn throttle and preserves sequential text exactly', () => {
    let time = 1_000;
    const frames: Array<() => void> = [];
    const output = new Map<string, string>();
    const scheduler = createStreamScheduler((key, chunks) => {
        output.set(key, (output.get(key) ?? '') + chunks.join(''));
    }, {
        raf: callback => { frames.push(callback); return frames.length; },
        now: () => time,
    });
    const first = 'a'.repeat(1024 * 1024 - 17);
    const second = 'b'.repeat(1024 * 1024 - 31);

    scheduler.beginTurn('turn-1');
    scheduler.push('turn-1', first);
    frames.shift()?.();
    assert.equal(scheduler.stats('turn-1')?.receivedChars, first.length);
    scheduler.push('turn-1', '!');
    frames.shift()?.();
    assert.equal(output.get('turn-1'), first, 'turn 1 is in the 400ms throttle tier');
    scheduler.flushTurn('turn-1');
    scheduler.resetTurn('turn-1');

    scheduler.beginTurn('turn-2');
    assert.equal(scheduler.stats('turn-2')?.receivedChars, 0);
    scheduler.push('turn-2', second);
    frames.shift()?.();
    assert.equal(output.get('turn-2'), second, 'turn 2 flushes immediately from a fresh lastFlushAt');
    assert.equal(scheduler.stats('turn-2')?.receivedChars, second.length);
    assert.equal(output.get('turn-1'), `${first}!`);
    assert.equal((output.get('turn-1')?.length ?? 0) + (output.get('turn-2')?.length ?? 0), first.length + 1 + second.length);
    time += 400;
});

test('fallback trace adoption flushes before the resolved turn key without stranding text', () => {
    const order: string[] = [];
    const output: string[] = [];
    const scheduler = createStreamScheduler((key, chunks) => {
        order.push(key);
        output.push(...chunks);
    }, { raf: () => 1, now: () => 0 });

    scheduler.push('trace:run-1', 'before');
    scheduler.flushTurn('trace:run-1');
    scheduler.resetTurn('trace:run-1');
    scheduler.beginTurn('turn-1');
    scheduler.push('turn-1', 'after');
    scheduler.flushTurn('turn-1');

    assert.deepEqual(order, ['trace:run-1', 'turn-1']);
    assert.equal(output.join(''), 'beforeafter');
    assert.equal(scheduler.stats('trace:run-1'), null);
});

test('agent_done flush ordering drains turn then tracked fallback keys before reset', () => {
    const order: string[] = [];
    const scheduler = createStreamScheduler((key) => order.push(key), { raf: () => 1, now: () => 0 });
    scheduler.push('turn-1', 'resolved');
    scheduler.push('trace:run-1', 'fallback');

    scheduler.flushTurn('turn-1');
    scheduler.resetTurn('turn-1');
    scheduler.flushTurn('trace:run-1');
    scheduler.resetTurn('trace:run-1');

    assert.deepEqual(order, ['turn-1', 'trace:run-1']);
    assert.equal(scheduler.stats('turn-1'), null);
    assert.equal(scheduler.stats('trace:run-1'), null);
});

test('scheduler dispose clears every key and ignores later work', () => {
    const flushed: string[] = [];
    const scheduler = createStreamScheduler((key) => flushed.push(key), { raf: () => 1 });
    scheduler.push('turn-1', 'pending');
    scheduler.push('turn-2', 'pending');
    scheduler.resetAll();
    assert.equal(scheduler.stats('turn-1'), null);
    scheduler.push('turn-3', 'pending');
    scheduler.dispose();
    scheduler.flushTurn('turn-3');
    scheduler.push('turn-4', 'ignored');
    assert.equal(scheduler.stats('turn-3'), null);
    assert.equal(scheduler.stats('turn-4'), null);
    assert.deepEqual(flushed, []);
});

test('fold snapshot is stable and fold-frame reconciliation detects gaps and duplicates', () => {
    const rows = [segment(), segment({ turnSeq: 2, segmentId: 'widget-1', type: 'widget' })];
    const expanded = prepareFoldSnapshot({ turnId: 'turn-1', rows }, true);
    const collapsed = prepareFoldSnapshot({ turnId: 'turn-1', rows }, false);
    assert.equal(expanded.shouldCollapseWidget, true);
    assert.ok(expanded.placeholderHeight > collapsed.placeholderHeight);
    assert.equal(expanded.foldKey, collapsed.foldKey);

    assert.deepEqual(reconcileFoldFrame(
        { turnId: 'turn-1', liveCount: 1, committedCount: 0 },
        { turnId: 'turn-1', liveCount: 0, committedCount: 1 },
    ), { duplicateCount: 0, missingCount: 0, maxVisibleCount: 1, isAtomic: true });
    assert.equal(reconcileFoldFrame(
        { turnId: 'turn-1', liveCount: 1, committedCount: 0 },
        { turnId: 'turn-1', liveCount: 0, committedCount: 0 },
    ).missingCount, 1);
    assert.equal(reconcileFoldFrame(
        { turnId: 'turn-1', liveCount: 1, committedCount: 0 },
        { turnId: 'turn-1', liveCount: 1, committedCount: 1 },
    ).duplicateCount, 1);
});

test('MarkdownSegment enforces URL, CSS, tag, and event-handler sanitization', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    (globalThis as any).window = dom.window;
    const html = renderToStaticMarkup(R.createElement(MarkdownSegment, {
        text: [
            '<script>alert(1)</script><iframe src="https://evil.test"></iframe>',
            '<a href="javascript:alert(2)" style="width: expression(alert(3))" onclick="alert(4)">bad</a>',
            '<img src="data:text/html;base64,PHNjcmlwdD4=" onerror="alert(5)">',
            '<a href="https://safe.test/path">https</a>',
            '<a href="mailto:safe@example.com">mail</a>',
            '<a href="/relative/path">relative</a>',
            '',
            '```ts',
            'const ok = true;',
            '```',
        ].join('\n'),
    }));
    assert.doesNotMatch(html, /<script|<iframe|onerror|onclick|style=|javascript:|data:text/i);
    assert.match(html, /href="https:\/\/safe\.test\/path"/);
    assert.match(html, /href="mailto:safe@example\.com"/);
    assert.match(html, /href="\/relative\/path"/);
    // R2: fenced code becomes an inert slot placeholder; CodeBlockSegment
    // mounts via portal (portal content does not appear in static markup)
    assert.match(html, /data-render-slot="[^"]*-code-0"/);
    dom.window.close();
    delete (globalThis as any).window;
});

test('MarkdownSegment same-text rerender does not parse markdown again', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    (globalThis as any).window = dom.window;
    (globalThis as any).document = dom.window.document;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const originalParse = marked.parse;
    let parses = 0;
    marked.parse = ((...args: Parameters<typeof originalParse>) => {
        parses++;
        return originalParse(...args);
    }) as typeof marked.parse;
    const root = createRoot(dom.window.document.querySelector('#root')!);
    try {
        await act(async () => root.render(R.createElement(MarkdownSegment, { text: '**same**' })));
        assert.equal(parses, 1);
        await act(async () => root.render(R.createElement(MarkdownSegment, { text: '**same**' })));
        assert.equal(parses, 1);
    } finally {
        await act(async () => root.unmount());
        marked.parse = originalParse;
        dom.window.close();
        delete (globalThis as any).window;
        delete (globalThis as any).document;
        delete (globalThis as any).Node;
        delete (globalThis as any).HTMLElement;
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    }
});
