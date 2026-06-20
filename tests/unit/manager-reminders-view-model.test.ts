import assert from 'node:assert/strict';
import test from 'node:test';

import type { DashboardReminder } from '../../public/manager/src/dashboard-reminders/reminders-api.ts';
import {
    buildTrayTriageSections,
    MATRIX_SECTIONS,
    matrixBucketToPatch,
    matrixItems,
    rankTopPriorityItems,
    remindersForView,
} from '../../public/manager/src/dashboard-reminders/reminders-view-model.ts';

function reminder(partial: Partial<DashboardReminder> & { id: string; title?: string }): DashboardReminder {
    return {
        id: partial.id,
        title: partial.title ?? partial.id,
        notes: partial.notes ?? '',
        listId: partial.listId ?? 'today',
        status: partial.status ?? 'open',
        priority: partial.priority ?? 'normal',
        manualRank: partial.manualRank ?? null,
        dueAt: partial.dueAt ?? null,
        remindAt: partial.remindAt ?? null,
        linkedInstance: partial.linkedInstance ?? null,
        subtasks: partial.subtasks ?? [],
        source: 'dashboard',
        sourceCreatedAt: partial.sourceCreatedAt ?? '2026-05-09T00:00:00.000Z',
        sourceUpdatedAt: partial.sourceUpdatedAt ?? '2026-05-09T00:00:00.000Z',
        mirroredAt: partial.mirroredAt ?? '2026-05-09T00:00:00.000Z',
        notificationStatus: partial.notificationStatus ?? 'pending',
        notificationAttemptedAt: partial.notificationAttemptedAt ?? null,
        notificationError: partial.notificationError ?? null,
        instanceId: partial.instanceId ?? null,
        messageId: partial.messageId ?? null,
        turnIndex: partial.turnIndex ?? null,
        port: partial.port ?? null,
        threadKey: partial.threadKey ?? null,
        sourceText: partial.sourceText ?? null,
    };
}

test('matrix and done views are disjoint global sidebar sets', () => {
    const items = [
        reminder({ id: 'high', priority: 'high' }),
        reminder({ id: 'important', priority: 'normal' }),
        reminder({ id: 'waiting', status: 'waiting' }),
        reminder({ id: 'later', listId: 'later', priority: 'low' }),
        reminder({ id: 'done', status: 'done', priority: 'high' }),
    ];

    assert.deepEqual(remindersForView('matrix', items).map(item => item.id), ['high', 'important', 'waiting', 'later']);
    assert.deepEqual(remindersForView('done', items).map(item => item.id), ['done']);
});

test('matrix buckets partition the matrix set exactly once', () => {
    const items = [
        reminder({ id: 'focused', status: 'focused', priority: 'low', listId: 'later' }),
        reminder({ id: 'high', priority: 'high' }),
        reminder({ id: 'important', priority: 'normal' }),
        reminder({ id: 'waiting', status: 'waiting' }),
        reminder({ id: 'later', listId: 'later', priority: 'low' }),
        reminder({ id: 'done', status: 'done' }),
    ];
    const matrixIds = remindersForView('matrix', items).map(item => item.id).sort();
    const bucketIds = MATRIX_SECTIONS
        .flatMap(section => matrixItems(section.id, items).map(item => item.id))
        .sort();

    assert.deepEqual(bucketIds, matrixIds);
});

test('matrix bucket patches map movement targets to dashboard reminder patches', () => {
    assert.deepEqual(matrixBucketToPatch('urgentImportant'), { listId: 'today', status: 'open', priority: 'high' });
    assert.deepEqual(matrixBucketToPatch('important'), { listId: 'today', status: 'open', priority: 'normal' });
    assert.deepEqual(matrixBucketToPatch('waiting'), { listId: 'waiting', status: 'waiting', priority: 'normal' });
    assert.deepEqual(matrixBucketToPatch('later'), { listId: 'later', status: 'open', priority: 'low' });
});

test('top priority ranks focused, urgency, manual rank, then due time', () => {
    const items = [
        reminder({ id: 'old-normal', priority: 'normal', sourceCreatedAt: '2026-05-09T00:00:00.000Z' }),
        reminder({ id: 'due-high', priority: 'high', dueAt: '2026-05-10T03:00:00.000Z', sourceCreatedAt: '2026-05-09T01:00:00.000Z' }),
        reminder({ id: 'remind-low', priority: 'low', remindAt: '2026-05-10T01:00:00.000Z', sourceCreatedAt: '2026-05-09T02:00:00.000Z' }),
        reminder({ id: 'focused', status: 'focused', priority: 'low', sourceCreatedAt: '2026-05-09T03:00:00.000Z' }),
        reminder({ id: 'done', status: 'done', priority: 'high', dueAt: '2026-05-10T00:00:00.000Z' }),
    ];

    assert.deepEqual(rankTopPriorityItems(items, 3).map(item => item.id), ['focused', 'due-high', 'old-normal']);
});

test('manual rank orders reminders inside each urgency tier', () => {
    const items = [
        reminder({ id: 'second-high', priority: 'high', manualRank: 3000 }),
        reminder({ id: 'first-normal', priority: 'normal', manualRank: 1000 }),
        reminder({ id: 'second-normal', priority: 'normal', manualRank: 2000 }),
        reminder({ id: 'fallback', priority: 'high' }),
    ];

    assert.deepEqual(rankTopPriorityItems(items, 4).map(item => item.id), ['second-high', 'fallback', 'first-normal', 'second-normal']);
    assert.deepEqual(matrixItems('urgentImportant', items).map(item => item.id), ['second-high', 'fallback']);
});

test('tray triage sections dedupe overdue priority and today rows', () => {
    const now = new Date(2026, 5, 20, 12, 0, 0);
    const items = [
        reminder({ id: 'overdue', priority: 'high', dueAt: new Date(2026, 5, 20, 8, 0, 0).toISOString() }),
        reminder({ id: 'priority-today', priority: 'high', dueAt: new Date(2026, 5, 20, 14, 0, 0).toISOString() }),
        reminder({ id: 'today-visible', priority: 'normal', dueAt: new Date(2026, 5, 20, 16, 0, 0).toISOString() }),
        reminder({ id: 'today-over-cap', priority: 'low', dueAt: new Date(2026, 5, 20, 18, 0, 0).toISOString() }),
        reminder({ id: 'future', dueAt: new Date(2026, 5, 21, 9, 0, 0).toISOString() }),
        reminder({ id: 'done', status: 'done', dueAt: new Date(2026, 5, 20, 10, 0, 0).toISOString() }),
    ];

    const sections = buildTrayTriageSections(items, now, 1);

    assert.deepEqual(sections.overdue.map(item => item.id), ['overdue']);
    assert.deepEqual(sections.priority.map(item => item.id), ['priority-today', 'today-visible', 'future']);
    assert.deepEqual(sections.today.map(item => item.id), ['today-over-cap']);
    assert.equal(sections.badgeCount, 4);
    assert.equal(sections.upcomingCount, 0);
});

test('tray triage leaves overdue uncapped and excludes done and future-only badge items', () => {
    const now = new Date(2026, 5, 20, 12, 0, 0);
    const sections = buildTrayTriageSections([
        reminder({ id: 'old-1', dueAt: new Date(2026, 5, 19, 8, 0, 0).toISOString() }),
        reminder({ id: 'old-2', dueAt: new Date(2026, 5, 18, 8, 0, 0).toISOString() }),
        reminder({ id: 'future', dueAt: new Date(2026, 5, 22, 8, 0, 0).toISOString() }),
        reminder({ id: 'done-today', status: 'done', dueAt: new Date(2026, 5, 20, 8, 0, 0).toISOString() }),
    ], now);

    assert.deepEqual(sections.overdue.map(item => item.id), ['old-2', 'old-1']);
    assert.equal(sections.badgeCount, 2);
});
