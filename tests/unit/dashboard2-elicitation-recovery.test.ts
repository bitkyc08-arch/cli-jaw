// 260725 wp3 — a failed elicitation submit must stay recoverable.
//
// The fence advances `index` past the last question BEFORE awaiting the
// submission. When the submit rejects, the catch restores status to 'active'
// but never rewinds the index, so `spec.questions[currentIndex]` is undefined
// and the component renders "질문 형식을 읽을 수 없습니다" — a format error for
// a perfectly well-formed spec. The real error and every retry path vanish.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h, act } from 'react';
import * as ReactNamespace from 'react';
import { JSDOM } from 'jsdom';

(globalThis as Record<string, unknown>).React = ReactNamespace;

function installDom(): JSDOM {
    const dom = new JSDOM('<div id="root"></div>');
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    for (const [name, value] of Object.entries({
        window: dom.window,
        document: dom.window.document,
        navigator: dom.window.navigator,
        HTMLElement: dom.window.HTMLElement,
    })) Object.defineProperty(globalThis, name, { configurable: true, value });
    return dom;
}

const SPEC = {
    questions: [{
        id: 'q1',
        question: 'pick one',
        type: 'single_select' as const,
        options: [{ id: 'a', label: 'A', value: 'a' }],
        visibleWhen: {},
    }],
};

async function answerWithFailingSubmit(): Promise<string> {
    const dom = installDom();
    const { createRoot } = await import('react-dom/client');
    const { ElicitationFence } = await import('../../public/dashboard2/src/turn-stream/render/fences/ElicitationFence.tsx');
    const { RenderActionPortsProvider } = await import('../../public/dashboard2/src/providers/render-action-ports.tsx');

    const ports = {
        submitMessage: async () => { throw new Error('network down'); },
        copyText: async () => {},
        openExternalUrl: () => {},
        openProtocolUrl: () => {},
    };

    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => root.render(
        h(RenderActionPortsProvider, { ports } as never, h(ElicitationFence, { spec: SPEC } as never)),
    ));

    const option = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === 'A');
    assert.ok(option, 'the option button must render');
    await act(async () => { option.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });

    return dom.window.document.getElementById('root')!.innerHTML;
}

test('a failed submit does not turn a valid spec into a format error', async () => {
    const html = await answerWithFailingSubmit();

    assert.equal(
        html.includes('질문 형식을 읽을 수 없습니다'),
        false,
        'the spec parsed fine; reporting a format error after a network failure sends the user to a dead end',
    );
});

test('a failed submit shows the real reason and leaves a way forward', async () => {
    const html = await answerWithFailingSubmit();

    assert.match(html, /network down/, 'the user must be told what actually failed');
    assert.match(html, /role="alert"/, 'and it must be announced');
    // Something has to be actionable, otherwise the answer is stranded.
    assert.match(html, /<button/, 'a retry path must remain');
});
