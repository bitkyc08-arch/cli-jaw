import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    buildOpencodeRuntimeSnapshot,
    pushOpencodeRawEvent,
    readOpencodePermissionSummary,
    readOpencodeVersion,
    redactOpencodeArgs,
    resolveOpencodeBinary,
} from '../../src/agent/opencode-diagnostics.ts';

test('redactOpencodeArgs redacts final prompt payload', () => {
    assert.deepEqual(
        redactOpencodeArgs(['run', '-m', 'opencode-go/deepseek-v4-pro', '--format', 'json', 'secret prompt']),
        ['run', '-m', 'opencode-go/deepseek-v4-pro', '--format', 'json', '<prompt:redacted>'],
    );
});

test('readOpencodePermissionSummary extracts external_directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-opencode-diag-'));
    const configPath = join(dir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({
        permission: {
            external_directory: 'allow',
            bash: 'allow',
            unknown_permission: 'ask',
        },
    }));

    const summary = readOpencodePermissionSummary(configPath);
    assert.equal(summary.external_directory, 'allow');
    assert.equal(summary.bash, 'allow');
    assert.equal(Object.prototype.hasOwnProperty.call(summary, 'unknown_permission'), false);
});

test('pushOpencodeRawEvent keeps ring limit', () => {
    let buffer: string[] | undefined;
    buffer = pushOpencodeRawEvent(buffer, 'a', 2);
    buffer = pushOpencodeRawEvent(buffer, 'b', 2);
    buffer = pushOpencodeRawEvent(buffer, 'c', 2);
    assert.deepEqual(buffer, ['b', 'c']);
});

test('buildOpencodeRuntimeSnapshot reports pending state', () => {
    const snapshot = buildOpencodeRuntimeSnapshot({
        finishReason: 'tool-calls',
        opencodePreToolText: 'abc',
        opencodePostToolText: 'defg',
        opencodePendingToolRefs: ['one', 'two'],
        opencodeRawEvents: ['{}'],
        opencodeLastEventType: 'tool_use',
        opencodeLastEventAt: 123,
    });

    assert.deepEqual(snapshot, {
        finishReason: 'tool-calls',
        pendingPreToolTextChars: 3,
        pendingPostToolTextChars: 4,
        pendingToolRefs: 2,
        rawEventCount: 1,
        lastEventType: 'tool_use',
        lastEventAt: 123,
    });
});

test('resolveOpencodeBinary finds fake opencode from PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-opencode-bin-'));
    const binary = join(dir, 'opencode');
    writeFileSync(binary, '#!/bin/sh\necho fake-opencode\n');
    chmodSync(binary, 0o755);

    const resolved = resolveOpencodeBinary({ PATH: `${dir}:/usr/bin:/bin` }, '');
    assert.equal(resolved, binary);
});

test('readOpencodeVersion never throws on missing binary', () => {
    assert.equal(readOpencodeVersion('/definitely/missing/opencode', {}), '');
});
