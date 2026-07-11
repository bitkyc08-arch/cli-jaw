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
    const flushed: string[][] = [];
    const scheduler = createStreamScheduler(chunks => flushed.push(chunks), {
        raf: callback => { frames.push(callback); return frames.length; },
        now: () => 0,
    });
    scheduler.push('a');
    scheduler.push('b');
    assert.equal(frames.length, 1);
    frames.shift()?.();
    assert.deepEqual(flushed, [['a', 'b']]);
    assert.deepEqual(scheduler.stats(), { flushCount: 1, maxBatch: 2 });
});

test('stream scheduler preserves every 20Hz chunk across a fake 60 second run', () => {
    let time = 0;
    const frames: Array<() => void> = [];
    const output: string[] = [];
    const scheduler = createStreamScheduler(chunks => output.push(...chunks), {
        raf: callback => { frames.push(callback); return frames.length; },
        now: () => time,
    });
    const expected: string[] = [];
    for (let index = 0; index < 20 * 60; index++) {
        const chunk = `[${index}]`;
        expected.push(chunk);
        scheduler.push(chunk);
        time += 50;
        const frame = frames.shift();
        frame?.();
    }
    scheduler.flushNow();
    assert.deepEqual(output, expected);
    assert.equal(new Set(output).size, expected.length);
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
    assert.match(html, /<pre><code class="language-ts">/);
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
