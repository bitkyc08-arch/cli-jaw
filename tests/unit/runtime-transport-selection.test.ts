import test from 'node:test';
import assert from 'node:assert/strict';
import { isRuntimeTransport, resolveRuntimeTransport, runtimeSessionBucket, isNativeSessionBucket,
    isSwitchableNativeCli, runtimeSelectionStatus } from '../../src/agent/runtime/selection.ts';

test('only explicit native opts in; unrecognized values retain print compatibility', () => {
    assert.equal(resolveRuntimeTransport('native'), 'native');
    assert.equal(resolveRuntimeTransport('print'), 'print');
    for (const value of [undefined, null, true, 0, [], {}, ['native'], 'Native', '']) {
        assert.equal(resolveRuntimeTransport(value), 'print');
        assert.equal(isRuntimeTransport(value), false);
    }
    assert.equal(isRuntimeTransport('native'), true);
    assert.equal(isRuntimeTransport('print'), true);
});

test('namespace prefix wraps the whole opaque legacy key without touching print bytes', () => {
    for (const key of ['cursor', 'grok:local:a', 'claude:local:a:b', 'cursor:native-v1:scope']) {
        assert.equal(runtimeSessionBucket(key, 'print'), key);
        assert.equal(runtimeSessionBucket(key, 'native'), 'native-v1:' + key);
        assert.equal(isNativeSessionBucket(runtimeSessionBucket(key, 'native')), true);
    }
    assert.equal(isNativeSessionBucket('cursor:native-v1:scope'), false);
});

test('compiled main and worker support are explicit, not binary/auth claims', () => {
    for (const cli of ['cursor', 'grok', 'claude']) {
        assert.equal(isSwitchableNativeCli(cli), true);
        assert.deepEqual(runtimeSelectionStatus(cli, 'native'), {
            transport: 'native', nativeAdapterImplemented: cli === 'cursor', nativeWorkerImplemented: false,
        });
    }
    for (const cli of ['codex-app', 'pi']) {
        assert.equal(isSwitchableNativeCli(cli), false);
        assert.deepEqual(runtimeSelectionStatus(cli, undefined), {
            transport: 'native', nativeAdapterImplemented: true, nativeWorkerImplemented: true,
        });
    }
});
