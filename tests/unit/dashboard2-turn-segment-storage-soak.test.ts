import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/core/db.ts';
import { appendTurnSegment, pruneTurnSegments } from '../../src/core/turn-segments.ts';
import type { TurnSegment } from '../../src/shared/chat-events.ts';

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 7;
const CYCLES = 6;
const ORPHANS_PER_CYCLE = 240;
const SESSION_PROTECTED_PER_CYCLE = 80;
const TRACE_PROTECTED_PER_CYCLE = 80;

test('dashboard2 turn-segment storage stays bounded across accelerated append/prune cycles', (t) => {
    const suffix = `${process.pid}-${Date.now()}`;
    const ownedPrefix = `storage-soak-${suffix}`;
    const sessionAnchor = `${ownedPrefix}-active-session`;
    const traceAnchor = `tr_${suffix.replaceAll('-', '').padEnd(16, '0')}`;
    const fixedNow = Date.now();
    const cutoff = fixedNow - RETENTION_DAYS * DAY_MS;
    const oldCreatedAt = cutoff - 1;

    const countSegments = db.prepare(`
        SELECT COUNT(*) AS count
        FROM turn_segments
        WHERE segment_id LIKE ?
    `);
    const insertMessage = db.prepare(`
        INSERT INTO messages (role, content, session_id, trace_run_id)
        VALUES (?, ?, ?, ?)
    `);
    const deleteOwnedSegments = db.prepare('DELETE FROM turn_segments WHERE segment_id LIKE ?');
    const deleteOwnedMessages = db.prepare('DELETE FROM messages WHERE content LIKE ?');
    const deleteTurn = db.prepare('DELETE FROM turn_segments WHERE turn_id = ?');
    const count = (category: string): number => {
        const row = countSegments.get(`${ownedPrefix}-${category}-%`) as { count: number };
        return row.count;
    };
    const appendBatch = (
        category: string,
        cycle: number,
        size: number,
        sessionId: string,
        createdAt: number,
        detailRef: TurnSegment['detailRef'] = null,
    ): void => {
        for (let index = 0; index < size; index += 1) {
            const identity = `${ownedPrefix}-${category}-${cycle}-${index}`;
            appendTurnSegment({
                turnId: identity,
                turnSeq: 1,
                segmentId: identity,
                sessionId,
                createdAt,
                observedAt: createdAt,
                providerAt: null,
                fidelity: 'full',
                thinkingMarker: null,
                type: detailRef ? 'tool' : 'assistant_text',
                status: 'done',
                detailRef,
            });
        }
    };

    t.mock.method(Date, 'now', () => fixedNow);
    t.after(() => {
        deleteOwnedSegments.run(`${ownedPrefix}-%`);
        deleteOwnedMessages.run(`${ownedPrefix}-%`);
    });

    insertMessage.run('assistant', `${ownedPrefix}-session-anchor`, sessionAnchor, null);
    insertMessage.run('assistant', `${ownedPrefix}-trace-anchor`, `${ownedPrefix}-other-session`, traceAnchor);

    const orphanCurve: Array<{ beforePrune: number; afterPrune: number }> = [];
    const protectedCurve: number[] = [];

    for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        appendBatch('orphan', cycle, ORPHANS_PER_CYCLE, `${ownedPrefix}-orphan-session-${cycle}`, oldCreatedAt);
        appendBatch('session-protected', cycle, SESSION_PROTECTED_PER_CYCLE, sessionAnchor, oldCreatedAt);
        appendBatch(
            'trace-protected',
            cycle,
            TRACE_PROTECTED_PER_CYCLE,
            `${ownedPrefix}-trace-session-${cycle}`,
            oldCreatedAt,
            { traceRunId: traceAnchor, traceSeq: 1 },
        );

        const boundaryTurnId = `${ownedPrefix}-boundary-${cycle}-0`;
        appendBatch('boundary', cycle, 1, `${ownedPrefix}-boundary-session-${cycle}`, cutoff);

        const orphanBeforePrune = count('orphan');
        assert.equal(orphanBeforePrune, ORPHANS_PER_CYCLE, `cycle ${cycle} should expose one orphan growth batch`);

        const result = pruneTurnSegments(RETENTION_DAYS);
        const orphanAfterPrune = count('orphan');
        orphanCurve.push({ beforePrune: orphanBeforePrune, afterPrune: orphanAfterPrune });

        assert.equal(result.deletedSegments, ORPHANS_PER_CYCLE, `cycle ${cycle} should prune only expired orphans`);
        assert.equal(orphanAfterPrune, 0, `cycle ${cycle} should return orphan storage to baseline`);
        assert.equal(count('boundary'), 1, `cycle ${cycle} should retain an orphan exactly at cutoff`);

        const expectedProtected = cycle * (SESSION_PROTECTED_PER_CYCLE + TRACE_PROTECTED_PER_CYCLE);
        const sessionProtected = count('session-protected');
        const traceProtected = count('trace-protected');
        protectedCurve.push(sessionProtected + traceProtected);
        assert.equal(sessionProtected, cycle * SESSION_PROTECTED_PER_CYCLE);
        assert.equal(traceProtected, cycle * TRACE_PROTECTED_PER_CYCLE);
        assert.equal(protectedCurve.at(-1), expectedProtected, `cycle ${cycle} protected curve should be exact`);

        deleteTurn.run(boundaryTurnId);
        assert.equal(count('boundary'), 0, `cycle ${cycle} boundary fixture should restore its baseline`);
    }

    assert.deepEqual(
        orphanCurve,
        Array.from({ length: CYCLES }, () => ({ beforePrune: ORPHANS_PER_CYCLE, afterPrune: 0 })),
    );
    assert.deepEqual(
        protectedCurve,
        Array.from(
            { length: CYCLES },
            (_, index) => (index + 1) * (SESSION_PROTECTED_PER_CYCLE + TRACE_PROTECTED_PER_CYCLE),
        ),
    );
});
