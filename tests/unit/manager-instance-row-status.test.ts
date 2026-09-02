import assert from 'node:assert/strict';
import test from 'node:test';
import {
    comparePinnedThenLabel,
    composeInstanceRowTitle,
    formatWorkingDurationLabel,
    resolveInstanceRowStatus,
} from '../../public/manager/src/components/instance-row-status.js';

test('resolveInstanceRowStatus prefers transitioning then working then health', () => {
    assert.equal(resolveInstanceRowStatus({ status: 'error' }, { busy: true, transitioning: 'restart' }), 'transitioning');
    assert.equal(resolveInstanceRowStatus({ status: 'timeout' }, { busy: true }), 'working');
    assert.equal(resolveInstanceRowStatus({ status: 'online' }, { busy: false }), 'online');
    assert.equal(resolveInstanceRowStatus({ status: 'offline' }), 'offline');
    assert.equal(resolveInstanceRowStatus({ status: 'timeout' }), 'attention');
    assert.equal(resolveInstanceRowStatus({ status: 'error' }), 'attention');
    assert.equal(resolveInstanceRowStatus({ status: 'unknown' }), 'attention');
});

test('formatWorkingDurationLabel matches t3 Sidebar.logic L723-728', () => {
    assert.equal(formatWorkingDurationLabel(0), '0s');
    assert.equal(formatWorkingDurationLabel(42_000), '42s');
    assert.equal(formatWorkingDurationLabel(5 * 60_000), '5m');
    assert.equal(formatWorkingDurationLabel(90 * 60_000), '1h 30m');
    assert.equal(formatWorkingDurationLabel(-5_000), '0s');
    assert.equal(formatWorkingDurationLabel(Number.NaN), '0s');
});

test('composeInstanceRowTitle is native tooltip copy', () => {
    assert.equal(
        composeInstanceRowTitle({ port: 3457, homeDisplay: '~/.cli-jaw', currentCli: 'pi', currentModel: 'opus', version: '2.17.30' }),
        ':3457 · ~/.cli-jaw · pi · opus · v2.17.30',
    );
});

test('comparePinnedThenLabel is favorite then label then port', () => {
    const labelOf = (row: { label?: string | null; port: number }) => row.label || String(row.port);
    const pinnedB = { favorite: true, label: 'beta', port: 2 };
    const pinnedA = { favorite: true, label: 'alpha', port: 1 };
    const plain = { favorite: false, label: 'aaa', port: 3 };
    assert.ok(comparePinnedThenLabel(pinnedA, plain, labelOf) < 0);
    assert.ok(comparePinnedThenLabel(pinnedA, pinnedB, labelOf) < 0);
});
