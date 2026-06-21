import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTrayQuickAddInput, defaultTrayQuickAddTime } from '../../public/manager/src/dashboard-reminders/tray-quick-add';

const NOW = new Date(2026, 5, 21, 10, 15, 0, 0);

function requireInput(result: ReturnType<typeof buildTrayQuickAddInput>) {
    assert.equal(result.ok, true, result.ok ? undefined : result.error);
    return result.input;
}

test('tray quick-add later mode creates an undated normal reminder', () => {
    const input = requireInput(buildTrayQuickAddInput({ title: '  Capture idea  ', mode: 'later' }, NOW));
    assert.equal(input.title, 'Capture idea');
    assert.equal(input.status, 'open');
    assert.equal(input.priority, 'normal');
    assert.equal(Object.hasOwn(input, 'dueAt'), false);
    assert.equal(Object.hasOwn(input, 'remindAt'), false);
});

test('tray quick-add important mode creates an undated high-priority reminder', () => {
    const input = requireInput(buildTrayQuickAddInput({ title: 'Write proposal', mode: 'important' }, NOW));
    assert.equal(input.title, 'Write proposal');
    assert.equal(input.status, 'open');
    assert.equal(input.priority, 'high');
    assert.equal(Object.hasOwn(input, 'dueAt'), false);
    assert.equal(Object.hasOwn(input, 'remindAt'), false);
});

test('tray quick-add urgent mode maps selected local time to due and remind dates', () => {
    const input = requireInput(buildTrayQuickAddInput({ title: 'Send note', mode: 'urgent', timeValue: '14:30' }, NOW));
    assert.equal(input.priority, 'normal');
    assert.equal(input.dueAt, input.remindAt);
    const due = new Date(input.dueAt ?? '');
    assert.equal(due.getFullYear(), 2026);
    assert.equal(due.getMonth(), 5);
    assert.equal(due.getDate(), 21);
    assert.equal(due.getHours(), 14);
    assert.equal(due.getMinutes(), 30);
});

test('tray quick-add important-urgent mode combines high priority with due time', () => {
    const input = requireInput(buildTrayQuickAddInput({ title: 'Fix outage', mode: 'important-urgent', timeValue: '11:45' }, NOW));
    assert.equal(input.priority, 'high');
    assert.equal(input.remindAt, input.dueAt);
    const due = new Date(input.dueAt ?? '');
    assert.equal(due.getDate(), 21);
    assert.equal(due.getHours(), 11);
    assert.equal(due.getMinutes(), 45);
});

test('tray quick-add rejects blank titles and invalid date controls', () => {
    assert.equal(buildTrayQuickAddInput({ title: ' ', mode: 'later' }, NOW).ok, false);
    assert.equal(buildTrayQuickAddInput({ title: 'Bad time', mode: 'urgent', timeValue: '25:00' }, NOW).ok, false);
    assert.equal(buildTrayQuickAddInput({ title: 'Bad urgent time', mode: 'important-urgent', timeValue: 'not-a-time' }, NOW).ok, false);
});

test('tray quick-add defaults are deterministic for injected now', () => {
    assert.equal(defaultTrayQuickAddTime(NOW), '11:00');
});
