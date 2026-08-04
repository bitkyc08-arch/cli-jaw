import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

/**
 * 260803 unit, 020 phase — D1 render-count evidence.
 *
 * The static assertions elsewhere only prove the throttle exists. This one
 * actually renders `useThrottledMarkdown` under jsdom and counts commits, so
 * the "fewer renders than tokens" claim is measured rather than asserted. It
 * also pins the correctness invariant that matters most: the final text must
 * always land, and an in-place edit must not be mistaken for streaming growth.
 */

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g['window'] = dom.window;
g['document'] = dom.window.document;
// Node 24 defines `navigator` as a getter-only global; React only needs it to
// exist, and Node's own value is sufficient.
if (!('navigator' in g)) g['navigator'] = dom.window.navigator;
g['HTMLElement'] = dom.window.HTMLElement;
g['requestAnimationFrame'] = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(Date.now()), 0);
g['cancelAnimationFrame'] = (id: number) => dom.window.clearTimeout(id);
g['IS_REACT_ACT_ENVIRONMENT'] = true;

const { createElement, useEffect, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { useThrottledMarkdown } = await import('../../public/manager/src/code/use-throttled-markdown.js');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('D1: throttling commits far fewer renders than incoming tokens, and the final text always lands', async () => {
    let renders = 0;
    let lastShown = '';

    function Probe({ text }: { text: string }) {
        const shown = useThrottledMarkdown(text);
        renders += 1;
        lastShown = shown;
        return createElement('span', null, shown);
    }

    function Harness() {
        const [text, setText] = useState('');
        useEffect(() => {
            let cancelled = false;
            void (async () => {
                let acc = '';
                // 120 tokens at ~8ms apart — a fast but realistic stream.
                for (let i = 0; i < 120 && !cancelled; i += 1) {
                    acc += `token${i} `;
                    setText(acc);
                    await sleep(8);
                }
            })();
            return () => { cancelled = true; };
        }, []);
        return createElement(Probe, { text });
    }

    const container = dom.window.document.getElementById('root')!;
    const root = createRoot(container);

    await act(async () => {
        root.render(createElement(Harness));
    });

    // Let the stream finish plus one full max interval for the trailing flush.
    await act(async () => {
        await sleep(120 * 8 + 600);
    });

    const expected = Array.from({ length: 120 }, (_, i) => `token${i} `).join('');

    // The whole point: the final text is never lost to throttling.
    assert.equal(lastShown, expected, 'trailing edge must flush the final text');

    // And it got there without one commit per token.
    assert.ok(
        renders < 120,
        `expected fewer commits than the 120 tokens fed, got ${renders}`,
    );

    await act(async () => { root.unmount(); });
});

test('D1: an in-place edit is shown immediately, not treated as streaming growth', async () => {
    let lastShown = '';

    function Probe({ text }: { text: string }) {
        lastShown = useThrottledMarkdown(text);
        return createElement('span', null, lastShown);
    }

    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);

    // Establish `visible`, then append once so the throttle window is HOT.
    // Without a recent emit the hook short-circuits on elapsed time and the
    // append/replace distinction is never exercised.
    const base = `${'x'.repeat(4000)}ORIGINAL${'y'.repeat(4000)}`;
    await act(async () => { root.render(createElement(Probe, { text: base })); });
    await act(async () => { await sleep(20); });
    assert.equal(lastShown, base, 'first paint is immediate');

    await act(async () => { root.render(createElement(Probe, { text: `${base}z` })); });
    await act(async () => { await sleep(5); });

    // Now rewrite content PAST the first 64 chars while keeping the prefix,
    // inside the throttle window. A prefix-only heuristic classifies this as
    // streaming growth and holds the stale text for the rest of the interval.
    const edited = `${'x'.repeat(4000)}REPLACED${'y'.repeat(4000)}`;
    await act(async () => { root.render(createElement(Probe, { text: edited })); });
    await act(async () => { await sleep(5); });

    assert.equal(lastShown, edited, 'an in-place edit must not be throttled as an append');

    await act(async () => { root.unmount(); });
});
