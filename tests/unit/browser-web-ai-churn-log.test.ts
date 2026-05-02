import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import {
    churnLogPath,
    readChurnLog,
    appendChurnRecord,
    compactChurnLog,
    maybeRecordChurn,
} from '../../src/browser/web-ai/churn-log.js';
import { JAW_HOME } from '../../src/core/config.js';

function clearChurnLog(): void {
    const path = churnLogPath();
    if (existsSync(path)) unlinkSync(path);
}

test('CL-001: churnLogPath returns path under home', () => {
    const path = churnLogPath();
    assert.ok(path.includes('churn-log.jsonl'));
});

test('CL-002: readChurnLog returns empty array when missing', () => {
    clearChurnLog();
    const records = readChurnLog();
    assert.deepEqual(records, []);
});

test('CL-003: appendChurnRecord and readChurnLog round-trip', () => {
    clearChurnLog();
    appendChurnRecord({
        key: 'chatgpt:composer',
        vendor: 'chatgpt',
        feature: 'composer',
        domHash: 'sha256:abc',
        previousHash: null,
        state: 'ok',
        capturedAt: new Date().toISOString(),
    });
    const records = readChurnLog();
    assert.equal(records.length, 1);
    assert.equal(records[0].key, 'chatgpt:composer');
});

test('CL-004: compactChurnLog truncates to limit', () => {
    clearChurnLog();
    for (let i = 0; i < 10; i++) {
        appendChurnRecord({
            key: `chatgpt:f${i}`,
            vendor: 'chatgpt',
            feature: `f${i}`,
            domHash: `hash-${i}`,
            previousHash: null,
            state: 'ok',
            capturedAt: new Date().toISOString(),
        });
    }
    const kept = compactChurnLog(JAW_HOME, 5);
    assert.equal(kept, 5);
    assert.equal(readChurnLog().length, 5);
});

test('CL-005: maybeRecordChurn respects env flag', () => {
    clearChurnLog();
    const prev = process.env.AGBROWSE_CHURN_LOG;
    process.env.AGBROWSE_CHURN_LOG = '0';
    const records = maybeRecordChurn({
        vendor: 'chatgpt',
        features: [{ feature: 'composer', domHash: 'sha256:x', state: 'ok' }],
    });
    assert.deepEqual(records, []);
    process.env.AGBROWSE_CHURN_LOG = prev;
});

test('CL-006: maybeRecordChurn writes changes when env flag set', () => {
    clearChurnLog();
    const prev = process.env.AGBROWSE_CHURN_LOG;
    process.env.AGBROWSE_CHURN_LOG = '1';
    const records = maybeRecordChurn({
        vendor: 'chatgpt',
        features: [{ feature: 'composer', domHash: 'sha256:new', state: 'ok' }],
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].previousHash, null);
    process.env.AGBROWSE_CHURN_LOG = prev;
});
