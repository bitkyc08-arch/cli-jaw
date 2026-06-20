import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTrayQuickAddInput, defaultTrayQuickAddDateTime, defaultTrayQuickAddTime } from '../../public/manager/src/dashboard-reminders/tray-quick-add';

const NOW = new Date(2026, 5, 21, 10, 15, 0, 0);

function requireInput(result: ReturnType<typeof buildTrayQuickAddInput>) {
    assert.equal(result.ok, true, result.ok ? undefined : result.error);
    return result.input;
}

test('tray quick-add inbox mode creates an undated normal reminder', () => {
    const input = requireInput(buildTrayQuickAddInput({ title: '  Capture idea  ', mode: 'inbox' }, NOW));
    assert.equal(input.title, 'Capture idea');
    assert.equal(input.status, 'open');
    assert.equal(input.priority, 'normal');
    assert.equal(Object.hasOwn(input, 'dueAt'), false);
    assert.equal(Object.hasOwn(input, 'remindAt'), false);
});

test('tray quick-add today mode maps selected local time to due and remind dates', () => {
    const input = requireInput(buildTrayQuickAddInput({ title: 'Send note', mode: 'today', timeValue: '14:30' }, NOW));
    assert.equal(input.dueAt, input.remindAt);
    const due = new Date(input.dueAt ?? '');
    assert.equal(due.getFullYear(), 2026);
    assert.equal(due.getMonth(), 5);
    assert.equal(due.getDate(), 21);
    assert.equal(due.getHours(), 14);
    assert.equal(due.getMinutes(), 30);
});

test('tray quick-add tomorrow mode maps selected local time to the next day', () => {
    const input = requireInput(buildTrayQuickAddInput({ title: 'Morning check', mode: 'tomorrow', timeValue: '09:00' }, NOW));
    assert.equal(input.dueAt, input.remindAt);
    const due = new Date(input.dueAt ?? '');
    assert.equal(due.getFullYear(), 2026);
    assert.equal(due.getMonth(), 5);
    assert.equal(due.getDate(), 22);
    assert.equal(due.getHours(), 9);
    assert.equal(due.getMinutes(), 0);
});

test('tray quick-add pick-date mode normalizes datetime-local to ISO', () => {
    const input = requireInput(buildTrayQuickAddInput({ title: 'Custom slot', mode: 'pick-date', dateTimeValue: '2026-06-25T16:45' }, NOW));
    assert.equal(input.dueAt, new Date('2026-06-25T16:45').toISOString());
    assert.equal(input.remindAt, input.dueAt);
});

test('tray quick-add rejects blank titles and invalid date controls', () => {
    assert.equal(buildTrayQuickAddInput({ title: ' ', mode: 'inbox' }, NOW).ok, false);
    assert.equal(buildTrayQuickAddInput({ title: 'Bad time', mode: 'today', timeValue: '25:00' }, NOW).ok, false);
    assert.equal(buildTrayQuickAddInput({ title: 'Bad date', mode: 'pick-date', dateTimeValue: 'not-a-date' }, NOW).ok, false);
});

test('tray quick-add defaults are deterministic for injected now', () => {
    assert.equal(defaultTrayQuickAddTime('today', NOW), '11:00');
    assert.equal(defaultTrayQuickAddTime('tomorrow', NOW), '09:00');
    assert.equal(defaultTrayQuickAddDateTime(NOW), '2026-06-21T11:00');
});
