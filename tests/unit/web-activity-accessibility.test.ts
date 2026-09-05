import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import { createActivityChoices, createActivityView } from '../../public/js/features/activity-view.ts';
import { createActivityState, applyActivityEvent, type ActivityState } from '../../src/shared/activity-state.ts';
import type { RuntimeEventBody } from '../../src/shared/runtime-contract.ts';

const identity = { version: 1 as const, sessionId: 'chat-a11y', scope: 'local:chat-a11y', runId: 'run-a11y', turnId: 'turn-a11y' };
function send(model: ActivityState, event: RuntimeEventBody): void {
    assert.equal(applyActivityEvent(model, { ...identity, ...event, seq: model.seq + 1 }), true);
}
function addTools(model: ActivityState, start: number, count: number): void {
    for (let i = start; i < start + count; i++) {
        send(model, { kind: 'tool', itemId: `tool-${i}`, name: `read ${i}`, output: '결과', status: 'running' });
    }
}
function mount(count = 0) {
    const host = document.createElement('div');
    host.className = 'agent-body';
    const answer = document.createElement('div');
    answer.className = 'msg-content';
    answer.textContent = 'Canonical answer';
    host.append(answer);
    const external = document.createElement('button');
    external.textContent = 'Outside Activity';
    document.body.append(host, external);
    const choices = createActivityChoices();
    const model = createActivityState(identity);
    addTools(model, 0, count);
    const view = createActivityView(host, choices);
    view.render(model);
    const group = view.element.querySelector<HTMLDetailsElement>('.activity-disclosure')!;
    const summary = view.element.querySelector<HTMLElement>('.activity-summary')!;
    const previous = view.element.querySelector<HTMLButtonElement>('.activity-previous')!;
    const next = view.element.querySelector<HTMLButtonElement>('.activity-next')!;
    return { host, answer, external, choices, model, view, group, summary, previous, next };
}

test.beforeEach(setupWebUiDom);
test.afterEach(resetWebUiDom);

test('bounded terminal error is literal text visible outside collapsed Activity without a final body', () => {
    const { model, view, group, answer } = mount();
    const error = '<img src=x onerror="alert(1)"><script>alert(2)</script> **failed** ' + '경로'.repeat(400);
    send(model, { kind: 'turn-end', status: 'error', error, finalText: 'FINAL_SENTINEL' });
    view.render(model);
    const notice = view.element.querySelector<HTMLElement>('.activity-error');
    assert.ok(notice);
    assert.equal(group.open, false);
    assert.equal(notice.hidden, false);
    assert.equal(notice.closest('details'), null);
    assert.equal(notice.textContent, error.slice(0, 500));
    assert.equal(view.element.querySelector('img, script, strong, .activity-final'), null);
    assert.doesNotMatch(view.element.textContent!, /FINAL_SENTINEL/);
    assert.equal(answer.textContent, 'Canonical answer');
});

test('stopped, successful and absent errors never show an error notice', () => {
    for (const status of ['stopped', 'done', 'error'] as const) {
        const { model, view } = mount();
        send(model, { kind: 'turn-end', status, finalText: null, ...(status === 'error' ? {} : { error: 'Not a failure' }) });
        view.render(model);
        const notice = view.element.querySelector<HTMLElement>('.activity-error');
        assert.ok(notice);
        assert.equal(notice.hidden, true);
        assert.equal(notice.textContent, '');
    }
    const { model, view } = mount();
    send(model, { kind: 'turn-end', status: 'error', finalText: null, error: 'Failure summary' });
    view.render(model);
    view.render(model, { status: 'stopped', degraded: true });
    assert.equal(view.element.querySelector<HTMLElement>('.activity-error')!.hidden, true);
    assert.doesNotMatch(view.element.textContent!, /Failure summary/);
    assert.match(view.element.querySelector('.activity-status')!.textContent!, /^Stopped/);
});

test('page clicks keep an enabled clicked button focused and use the opposite button at either boundary', t => {
    const { group, previous, next } = mount(81);
    group.open = true;
    const focusPrevious = t.mock.method(previous, 'focus');
    const focusNext = t.mock.method(next, 'focus');
    // DOM click also covers browsers where a pointer click does not focus a button.
    previous.click();
    assert.equal(previous.disabled, false);
    assert.equal(document.activeElement, previous);
    assert.deepEqual(focusPrevious.mock.calls.at(-1)!.arguments, [{ preventScroll: true }]);
    previous.click();
    assert.equal(previous.disabled, true);
    assert.equal(document.activeElement, next);
    assert.deepEqual(focusNext.mock.calls.at(-1)!.arguments, [{ preventScroll: true }]);
    next.click();
    assert.equal(next.disabled, false);
    assert.equal(document.activeElement, next);
    next.click();
    assert.equal(next.disabled, true);
    assert.equal(document.activeElement, previous);
});

test('page click falls back to group summary when updated entries leave no enabled page control', t => {
    const { model, group, summary, previous, next } = mount(41);
    group.open = true;
    previous.focus();
    model.entries.clear();
    const focusSummary = t.mock.method(summary, 'focus');
    previous.click();
    assert.equal(previous.disabled, true);
    assert.equal(next.disabled, true);
    assert.equal(document.activeElement, summary);
    assert.deepEqual(focusSummary.mock.calls.at(-1)!.arguments, [{ preventScroll: true }]);
});

test('eviction of a focused tool restores summary focus while retaining explicit disclosure choices', t => {
    const { model, view, group, summary, choices } = mount(1);
    group.open = true;
    const row = view.element.querySelector<HTMLDetailsElement>('.activity-item')!;
    row.open = true;
    row.querySelector('summary')!.focus();
    const focusSummary = t.mock.method(summary, 'focus');
    addTools(model, 1, 130);
    view.render(model);
    assert.equal(row.isConnected, false);
    assert.equal(document.activeElement, summary);
    assert.deepEqual(focusSummary.mock.calls.at(-1)!.arguments, [{ preventScroll: true }]);
    assert.equal(group.open, true);
    assert.equal(choices.items.get('tool-0'), true);
});

test('an externally selected page removing the focused row restores summary focus', () => {
    const { model, view, group, summary, choices } = mount(81);
    group.open = true;
    const row = view.element.querySelector<HTMLDetailsElement>('.activity-item')!;
    row.querySelector('summary')!.focus();
    choices.page = 0;
    view.render(model);
    assert.equal(row.isConnected, false);
    assert.equal(document.activeElement, summary);
});

test('routine streaming and row eviction preserve external focus and do not rewrite unchanged status text', t => {
    const { model, view, summary, external } = mount(1);
    const status = view.element.querySelector('.activity-status')!;
    const statusText = status.firstChild;
    const focusSummary = t.mock.method(summary, 'focus');
    external.focus();
    addTools(model, 0, 1);
    view.render(model);
    addTools(model, 1, 130);
    view.render(model);
    assert.equal(status.firstChild, statusText);
    assert.equal(document.activeElement, external);
    assert.equal(focusSummary.mock.callCount(), 0);
    send(model, { kind: 'turn-end', status: 'error', error: 'Read failed', finalText: null });
    view.render(model);
    assert.equal(document.activeElement, external);
    assert.equal(focusSummary.mock.callCount(), 0);
});

test('routine tool replacement and terminal render preserve the focused expanded row', () => {
    const { model, view, group, choices } = mount(1);
    group.open = true;
    const row = view.element.querySelector<HTMLDetailsElement>('.activity-item')!;
    row.open = true;
    const title = row.querySelector('summary')!;
    title.focus();
    send(model, { kind: 'tool', itemId: 'tool-0', name: 'read 0', output: 'updated', status: 'done' });
    view.render(model);
    send(model, { kind: 'turn-end', status: 'error', error: 'Later failure', finalText: null });
    view.render(model);
    assert.equal(document.activeElement, title);
    assert.equal(row.open, true);
    assert.equal(group.open, true);
    assert.equal(choices.items.get('tool-0'), true);
});
