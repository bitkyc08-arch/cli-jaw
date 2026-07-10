import test from 'node:test';
import assert from 'node:assert/strict';

import { startHeartbeatCronLoop } from '../../src/memory/heartbeat-schedule.ts';
import { isHeartbeatQuietOutput } from '../../src/memory/heartbeat.ts';

test('startHeartbeatCronLoop runs current minute immediately and arms next tick', () => {
    const events: string[] = [];
    let scheduledTick: (() => void) | null = null;

    startHeartbeatCronLoop(
        () => { events.push('run'); },
        (tick) => {
            events.push('arm');
            scheduledTick = tick;
        },
    );

    assert.deepEqual(events, ['run', 'arm']);
    assert.equal(typeof scheduledTick, 'function');
});

test('startHeartbeatCronLoop re-arms after each tick', () => {
    const events: string[] = [];
    let scheduledTick: (() => void) | null = null;

    startHeartbeatCronLoop(
        () => { events.push('run'); },
        (tick) => {
            events.push('arm');
            scheduledTick = tick;
        },
    );

    scheduledTick?.();

    assert.deepEqual(events, ['run', 'arm', 'run', 'arm']);
});

test('startHeartbeatCronLoop still arms next tick when runCurrent throws', () => {
    const events: string[] = [];

    assert.throws(() => {
        startHeartbeatCronLoop(
            () => {
                events.push('run');
                throw new Error('boom');
            },
            () => { events.push('arm'); },
        );
    }, /boom/);

    assert.deepEqual(events, ['run', 'arm']);
});

test('heartbeat quiet output preserves SILENT and supports configured extra markers', () => {
    assert.equal(isHeartbeatQuietOutput('done [SILENT]'), true);
    assert.equal(isHeartbeatQuietOutput('HEARTBEAT_OK', ['HEARTBEAT_OK']), true);
    assert.equal(isHeartbeatQuietOutput('ordinary output', ['HEARTBEAT_OK']), false);
});
