import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import { createActivityChoices, rememberActivityChoice, createActivityView } from '../../public/js/features/activity-view.ts';
import { createActivityState, applyActivityEvent } from '../../src/shared/activity-state.ts';
import type { ActivityState } from '../../src/shared/activity-state.ts';
import type { RuntimeEventBody, RuntimeItemStatus } from '../../src/shared/runtime-contract.ts';
import { classifyExitError } from '../../src/agent/error-classifier.ts';

const identity = { version: 1 as const, sessionId: 'chat-a', scope: 'local:chat-a', runId: 'run-a', turnId: 'turn-a', seq: 1 };
function send(model: ActivityState, body: RuntimeEventBody): void {
    assert.equal(applyActivityEvent(model, { ...identity, ...body, seq: model.seq + 1 }), true);
}
function tool(model: ActivityState, id: string, output = '결과', status: RuntimeItemStatus = 'running'): void {
    send(model, { kind: 'tool', itemId: id, name: `read ${id}`, output, status });
}
function mount(inspect?: (state: ActivityState) => void) {
    const message = document.createElement('div');
    message.className = 'msg-agent';
    message.innerHTML = '<div class="agent-body"><div class="process-block">Legacy</div><div class="msg-content">Canonical answer</div><div class="message-actions"><button>Copy</button></div></div>';
    document.body.append(message);
    const host = message.querySelector<HTMLElement>('.agent-body')!;
    const answer = host.querySelector<HTMLElement>('.msg-content')!;
    const choices = createActivityChoices();
    const model = createActivityState(identity);
    const view = createActivityView(host, choices, inspect);
    const group = view.element.querySelector<HTMLDetailsElement>('.activity-disclosure')!;
    return { message, host, answer, choices, model, view, group };
}
function rows(root: Element): HTMLDetailsElement[] {
    return [...root.querySelectorAll<HTMLDetailsElement>('[data-activity-item-id]')];
}
function button(root: Element, label: string): HTMLButtonElement {
    const result = [...root.querySelectorAll('button')].find(node => node.textContent === label);
    assert.ok(result, `Missing button: ${label}`);
    return result;
}
async function toggle(node: HTMLDetailsElement, open: boolean): Promise<void> {
    const changed = new Promise<void>(resolve => node.addEventListener('toggle', () => resolve(), { once: true }));
    node.open = open;
    await changed;
}

test.beforeEach(setupWebUiDom);
test.afterEach(resetWebUiDom);

test('empty Activity mounts before the untouched answer and has no unavailable Trace control', () => {
    const { host, answer, model, view, group } = mount();
    view.render(model);
    assert.equal(view.element.nextElementSibling, answer);
    assert.equal(group.open, false);
    assert.equal(rows(view.element).length, 0);
    assert.match(view.element.textContent!, /No activity recorded/);
    assert.equal(view.element.querySelector('.activity-status')?.textContent, 'Working');
    assert.equal(view.element.querySelector('.activity-status')?.getAttribute('role'), 'status');
    assert.equal(view.element.querySelector('.activity-trace'), null);
    assert.equal(host.querySelector('.message-actions button')?.textContent, 'Copy');
    assert.equal(answer.textContent, 'Canonical answer');
});

test('terminal text never creates or modifies a final answer, including empty and null', () => {
    for (const finalText of ['FINAL_SENTINEL' + '끝'.repeat(40000), '', null]) {
        const { model, view, answer, host } = mount();
        send(model, { kind: 'message', itemId: 'comment', phase: 'commentary', text: 'Checking files', operation: 'replace' });
        send(model, { kind: 'turn-end', status: 'done', finalText });
        view.render(model);
        view.render(model);
        assert.equal(host.querySelectorAll('.msg-content').length, 1);
        assert.equal(host.querySelector('.msg-content'), answer);
        assert.equal(answer.textContent, 'Canonical answer');
        assert.equal(view.element.querySelector('.activity-final'), null);
        assert.doesNotMatch(view.element.textContent!, /FINAL_SENTINEL|Canonical answer/);
    }
});

test('tool fields and latest action render literal XSS text without HTML or markdown', () => {
    const { model, view, group } = mount();
    const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script> **bold**';
    send(model, { kind: 'tool', itemId: '"]<img>', name: attack, input: attack, output: attack, detail: attack, status: 'running' });
    view.render(model);
    assert.equal(group.open, false);
    assert.match(group.firstElementChild!.textContent!, /1 retained preview/);
    assert.ok(group.firstElementChild!.textContent!.includes(attack));
    assert.equal(view.element.querySelector('img, script, strong'), null);
    assert.equal(rows(view.element)[0].querySelector('pre')?.textContent, [attack, attack, attack].join('\n'));
});

test('explicit disclosure and focused keyed tool survive replacement, growth and turn end', async () => {
    const { model, choices, view, group } = mount();
    tool(model, 'tool-0', 'old');
    view.render(model);
    await toggle(group, true);
    const row = rows(view.element)[0];
    await toggle(row, true);
    const title = row.querySelector('summary')!;
    title.focus();
    tool(model, 'tool-0', 'new', 'done');
    for (let i = 1; i <= 80; i++) tool(model, `tool-${i}`);
    view.render(model);
    send(model, { kind: 'turn-end', status: 'done', finalText: 'Answer' });
    view.render(model);
    assert.equal(rows(view.element)[0], row);
    assert.equal(row.querySelector('pre')?.textContent, 'new');
    assert.equal(row.open, true);
    assert.equal(group.open, true);
    assert.equal(choices.open, true);
    assert.equal(choices.items.get('tool-0'), true);
    assert.equal(document.activeElement, title);
    assert.equal(rows(view.element).length, 40);
    assert.match(group.firstElementChild!.textContent!, /read tool-80/);
    assert.match(group.firstElementChild!.textContent!, /81 retained previews/);
});

test('explicit close and open choices persist across paging and DOM recycling', async () => {
    const { model, choices, host, view, group } = mount();
    for (let i = 0; i < 41; i++) tool(model, `tool-${i}`);
    view.render(model);
    await toggle(group, true);
    await toggle(rows(view.element)[0], true);
    button(view.element, 'Earlier activity').click();
    button(view.element, 'Later activity').click();
    assert.equal(rows(view.element)[0].open, true);
    await toggle(rows(view.element)[0], false);
    await toggle(group, false);
    view.dispose();
    const recycled = createActivityView(host, choices);
    recycled.render(model);
    assert.equal(recycled.element.querySelector<HTMLDetailsElement>('.activity-disclosure')!.open, false);
    assert.equal(rows(recycled.element)[0].open, false);
    assert.equal(choices.items.has('tool-40'), false);
    await toggle(recycled.element.querySelector<HTMLDetailsElement>('.activity-disclosure')!, true);
    await toggle(rows(recycled.element)[0], true);
    recycled.dispose();
    const restored = createActivityView(host, choices);
    restored.render(model);
    assert.equal(rows(restored.element)[0].open, true);
    assert.equal(restored.element.querySelector<HTMLDetailsElement>('.activity-disclosure')!.open, true);
});

test('40/41/81 entry pages follow latest until selected and clamp when entries shrink', () => {
    const { model, choices, view } = mount();
    for (let i = 0; i < 40; i++) tool(model, `tool-${i}`);
    view.render(model);
    assert.equal(rows(view.element).length, 40);
    assert.equal(view.element.querySelector<HTMLElement>('nav')!.hidden, true);
    tool(model, 'tool-40');
    view.render(model);
    assert.equal(rows(view.element).length, 1);
    assert.equal(rows(view.element)[0].dataset.activityItemId, 'tool-40');
    assert.equal(choices.page, null);
    for (let i = 41; i < 81; i++) tool(model, `tool-${i}`);
    view.render(model);
    assert.equal(rows(view.element)[0].dataset.activityItemId, 'tool-80');
    button(view.element, 'Earlier activity').click();
    assert.equal(rows(view.element).length, 40);
    assert.equal(rows(view.element)[0].dataset.activityItemId, 'tool-40');
    button(view.element, 'Earlier activity').click();
    assert.equal(rows(view.element)[0].dataset.activityItemId, 'tool-0');
    assert.equal(button(view.element, 'Earlier activity').disabled, true);
    choices.page = 999;
    view.render(model);
    assert.equal(rows(view.element)[0].dataset.activityItemId, 'tool-80');
    assert.equal(button(view.element, 'Later activity').disabled, true);
    model.entries.clear();
    view.render(model);
    assert.equal(rows(view.element).length, 0);
    assert.equal(button(view.element, 'Earlier activity').disabled, true);
});

test('pending native toggles survive immediate recycle and preview eviction does not discard choices', () => {
    const { model, choices, host, view, group } = mount();
    tool(model, 'remembered');
    view.render(model);
    group.open = true;
    rows(view.element)[0].open = true;
    // Recycle before the queued toggle event runs.
    view.dispose();
    assert.equal(choices.open, true);
    assert.equal(choices.items.get('remembered'), true);
    const recycled = createActivityView(host, choices);
    for (let i = 0; i < 130; i++) tool(model, `later-${i}`);
    recycled.render(model);
    assert.equal(model.entries.has('remembered'), false);
    assert.equal(choices.items.get('remembered'), true);
    assert.ok(rows(recycled.element).length <= 40);
    tool(model, 'remembered', 'returned snapshot');
    choices.page = null;
    recycled.render(model);
    const returned = rows(recycled.element).find(row => row.dataset.activityItemId === 'remembered')!;
    assert.equal(returned.open, true);
    assert.equal(returned.querySelector('pre')!.textContent, 'returned snapshot');
});

test('view text clipping is visible even when the reducer retained all text and the group is collapsed', () => {
    const { model, view, group } = mount();
    tool(model, 'long', '가'.repeat(3500));
    assert.equal(model.omitted.textChars, 0);
    view.render(model);
    assert.equal(group.open, false);
    const notice = view.element.querySelector<HTMLElement>('.activity-omitted')!;
    assert.equal(notice.hidden, false);
    assert.equal(notice.closest('details'), null);
    assert.match(notice.textContent!, /omitted/);
});

test('choice saturation preserves all 128 prior choices, refuses new opens and recovers after closing', async () => {
    const { model, choices, view } = mount();
    for (let i = 0; i < 128; i++) assert.equal(rememberActivityChoice(choices, `old-${i}`, true), true);
    assert.equal(rememberActivityChoice(choices, 'new', true), false);
    tool(model, 'new');
    view.render(model);
    const row = rows(view.element)[0];
    await toggle(row, true);
    assert.equal(row.open, false);
    assert.equal(choices.items.size, 128);
    view.render(model);
    assert.match(view.element.querySelector('.activity-choice-notice')!.textContent!, /128/);
    assert.equal(view.element.querySelector<HTMLElement>('.activity-choice-notice')!.hidden, false);
    assert.equal(rememberActivityChoice(choices, 'old-0', false), true);
    await toggle(row, true);
    assert.equal(row.open, true);
    assert.equal(choices.items.size, 128);
    assert.equal(choices.items.get('new'), true);
});

test('status distinguishes terminal outcomes without rewriting unfinished tools; degraded survives pagination', () => {
    const classified=classifyExitError('codex-app',1,'connection lost\n    at RAW_STACK_SENTINEL (private.ts:1)');
    assert.match(classified.detail,/RAW_STACK_SENTINEL/);
    for (const [status, label] of [['done', 'Complete'], ['stopped', 'Stopped'], ['error', 'Failed']] as const) {
        const { model, view } = mount();
        tool(model, 'unfinished');
        send(model, { kind: 'turn-end', status, finalText: null, error: classified.message });
        view.render(model);
        assert.match(view.element.querySelector('.activity-status')!.textContent!, new RegExp(`^${label}`));
        assert.match(rows(view.element)[0].querySelector('summary')!.textContent!, /running/);
        assert.doesNotMatch(view.element.textContent!, /RAW_STACK_SENTINEL/);
        if(status==='error')assert.equal(view.element.querySelector('.activity-error')?.textContent,classified.message);
    }
    const { model, view } = mount();
    for (let i = 0; i < 41; i++) tool(model, `tool-${i}`);
    view.render(model, { status: 'stopped', degraded: true });
    button(view.element, 'Earlier activity').click();
    assert.match(view.element.querySelector('.activity-status')!.textContent!, /^Stopped/);
    assert.equal(view.element.querySelector<HTMLElement>('.activity-degraded')!.hidden, false);
    assert.match(view.element.querySelector('.activity-degraded')!.textContent!, /incomplete/i);
    assert.equal(model.end, null);
    view.render(model, {});
    assert.equal(view.element.querySelector('.activity-status')!.textContent, 'Working');
    assert.equal(view.element.querySelector<HTMLElement>('.activity-degraded')!.hidden, true);
});

test('omission and request notices stay visible when collapsed; Trace is an optional sibling action', () => {
    const inspected: ActivityState[] = [];
    const { model, view, group } = mount(state => inspected.push(state));
    tool(model, 'long', '가'.repeat(4000));
    model.omitted.entries = 1;
    send(model, { kind: 'request', requestId: 'approval', requestType: 'approval', view: { title: 'Approve', fields: [] } });
    view.render(model);
    assert.equal(group.open, false);
    const omitted = view.element.querySelector<HTMLElement>('.activity-omitted')!;
    assert.equal(omitted.hidden, false);
    assert.equal(omitted.closest('details'), null);
    assert.match(omitted.textContent!, /omitted/i);
    assert.match(view.element.textContent!, /live Requests/);
    assert.match(rows(view.element)[0].querySelector('pre')!.textContent!, /Preview limited/);
    assert.ok(rows(view.element)[0].querySelector('pre')!.textContent!.length < 3200);
    const trace = button(view.element, 'Inspect retained activity');
    assert.equal(trace.closest('summary'), null);
    assert.equal(trace.closest('details'), null);
    assert.equal(view.element.querySelector('input, select, textarea'), null);
    trace.click();
    assert.deepEqual(inspected, [model]);
    view.dispose();
    trace.click();
    view.render(model);
    assert.equal(inspected.length, 1);
    assert.equal(view.element.isConnected, false);
});

test('CSS mode switch hides only semantic legacy previews and live answer, and is reversible', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('../../public/css/activity.css', import.meta.url), 'utf8');
    document.head.append(style);
    const { message, host, answer, model, view } = mount();
    const unrelated = mount();
    message.dataset.activityKey = 'key';
    message.dataset.activityLive = 'true';
    view.render(model);
    const process = host.querySelector<HTMLElement>('.process-block')!;
    assert.equal(getComputedStyle(process).display, 'none');
    assert.equal(getComputedStyle(answer).display, 'none');
    assert.notEqual(getComputedStyle(unrelated.answer).display, 'none');
    message.dataset.activityLive = 'false';
    assert.notEqual(getComputedStyle(answer).display, 'none');
    document.documentElement.dataset.presentationMode = 'legacy';
    assert.equal(getComputedStyle(view.element).display, 'none');
    assert.notEqual(getComputedStyle(process).display, 'none');
    document.documentElement.dataset.presentationMode = 'activity';
    assert.notEqual(getComputedStyle(view.element).display, 'none');
    assert.equal(getComputedStyle(process).display, 'none');
});

test('empty stopped/error turns never claim partial output was retained', () => {
    for (const [status, label] of [['stopped', 'Stopped'], ['error', 'Failed']] as const) {
        const { model, view } = mount();
        send(model, { kind: 'turn-end', status, finalText: null });
        view.render(model);
        assert.equal(view.element.querySelector('.activity-status')!.textContent, label);
        assert.equal(rows(view.element).length, 0);
        assert.equal(view.element.querySelector('.activity-final'), null);
    }
});
