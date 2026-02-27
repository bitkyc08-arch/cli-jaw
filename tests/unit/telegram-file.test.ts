import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateFileSize, sendTelegramFile, TELEGRAM_LIMITS, classifyUpstreamError } from '../../src/telegram/telegram-file.ts';

// ─── helpers ───────────────────────────────────────────

function tmpFile(sizeMB: number): string {
    const p = path.join(os.tmpdir(), `jaw-tg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(p, Buffer.alloc(sizeMB * 1024 * 1024));
    return p;
}

function cleanup(p: string) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

function mockBot({ failTimes = 0, errorCode = 429, retryAfter = 0, useHttpError = false } = {}) {
    let calls = 0;
    return {
        calls: () => calls,
        api: {
            async sendDocument(_c: any, _f: any, _o?: any) {
                calls++;
                if (calls <= failTimes) {
                    if (useHttpError) {
                        // Simulate grammY HttpError (network-level)
                        const err: any = new Error('network timeout');
                        err.constructor = { name: 'HttpError' };
                        throw err;
                    }
                    // Simulate grammY GrammyError (API-level)
                    const err: any = new Error(`mock ${errorCode}`);
                    err.error_code = errorCode;
                    if (retryAfter) err.parameters = { retry_after: retryAfter };
                    throw err;
                }
                return { ok: true };
            },
            async sendVoice(c: any, f: any, o?: any) { return this.sendDocument(c, f, o); },
            async sendPhoto(c: any, f: any, o?: any) { return this.sendDocument(c, f, o); },
        },
    };
}

// ─── validateFileSize ──────────────────────────────────

test('validateFileSize: voice 49MB passes (under 50MB limit)', () => {
    const f = tmpFile(49);
    try { assert.doesNotThrow(() => validateFileSize(f, 'voice')); }
    finally { cleanup(f); }
});

test('validateFileSize: voice 51MB rejected', () => {
    const f = tmpFile(51);
    try { assert.throws(() => validateFileSize(f, 'voice'), /too large/i); }
    finally { cleanup(f); }
});

test('validateFileSize: photo 11MB rejected (10MB limit)', () => {
    const f = tmpFile(11);
    try { assert.throws(() => validateFileSize(f, 'photo'), /too large/i); }
    finally { cleanup(f); }
});

test('validateFileSize: document 1MB passes', () => {
    const f = tmpFile(1);
    try { assert.doesNotThrow(() => validateFileSize(f, 'document')); }
    finally { cleanup(f); }
});

test('validateFileSize: text type is skipped (no limit)', () => {
    const f = tmpFile(1);
    try { assert.doesNotThrow(() => validateFileSize(f, 'text')); }
    finally { cleanup(f); }
});

// ─── sendTelegramFile: success ─────────────────────────

test('sendTelegramFile: succeeds on first attempt', async () => {
    const bot = mockBot();
    const f = tmpFile(0);
    try {
        const r = await sendTelegramFile(bot, 123, f, 'document');
        assert.equal(r.ok, true);
        assert.equal(r.attempts, 1);
    } finally { cleanup(f); }
});

// ─── sendTelegramFile: retry on 429 ───────────────────

test('sendTelegramFile: retries on 429 then succeeds', async () => {
    const bot = mockBot({ failTimes: 2, errorCode: 429 });
    const f = tmpFile(0);
    try {
        const r = await sendTelegramFile(bot, 123, f, 'document');
        assert.equal(r.ok, true);
        assert.equal(r.attempts, 3);
    } finally { cleanup(f); }
});

// ─── sendTelegramFile: retry on 5xx ───────────────────

test('sendTelegramFile: retries on 500 then succeeds', async () => {
    const bot = mockBot({ failTimes: 1, errorCode: 500 });
    const f = tmpFile(0);
    try {
        const r = await sendTelegramFile(bot, 123, f, 'document');
        assert.equal(r.ok, true);
        assert.equal(r.attempts, 2);
    } finally { cleanup(f); }
});

// ─── sendTelegramFile: HttpError retry ────────────────

test('sendTelegramFile: retries on HttpError (network)', async () => {
    const bot = mockBot({ failTimes: 1, useHttpError: true });
    const f = tmpFile(0);
    try {
        const r = await sendTelegramFile(bot, 123, f, 'document');
        assert.equal(r.ok, true);
        assert.equal(r.attempts, 2);
    } finally { cleanup(f); }
});

// ─── sendTelegramFile: no retry on 4xx (not 429) ──────

test('sendTelegramFile: does NOT retry on 400 (permanent)', async () => {
    const bot = mockBot({ failTimes: 5, errorCode: 400 });
    const f = tmpFile(0);
    try {
        const r = await sendTelegramFile(bot, 123, f, 'document');
        assert.equal(r.ok, false);
        assert.equal(r.attempts, 1);
        assert.equal(r.statusCode, 400); // GrammyError.error_code passed through
    } finally { cleanup(f); }
});

test('sendTelegramFile: does NOT retry on 403 (permanent)', async () => {
    const bot = mockBot({ failTimes: 5, errorCode: 403 });
    const f = tmpFile(0);
    try {
        const r = await sendTelegramFile(bot, 123, f, 'document');
        assert.equal(r.ok, false);
        assert.equal(r.attempts, 1);
        assert.equal(r.statusCode, 403); // GrammyError.error_code passed through
    } finally { cleanup(f); }
});

// ─── sendTelegramFile: exhaust retries ────────────────

test('sendTelegramFile: gives up after max retries', async () => {
    const bot = mockBot({ failTimes: 10, errorCode: 500 });
    const f = tmpFile(0);
    try {
        const r = await sendTelegramFile(bot, 123, f, 'document');
        assert.equal(r.ok, false);
        assert.equal(r.attempts, 3);
        assert.ok(r.error);
        assert.equal(r.statusCode, 502);
    } finally { cleanup(f); }
});

// ─── sendTelegramFile: retry_after respected ──────────

test('sendTelegramFile: 429 with retry_after=1 succeeds after wait', async () => {
    const bot = mockBot({ failTimes: 1, errorCode: 429, retryAfter: 1 });
    const f = tmpFile(0);
    try {
        const r = await sendTelegramFile(bot, 123, f, 'document');
        assert.equal(r.ok, true);
        assert.equal(r.attempts, 2);
    } finally { cleanup(f); }
});

// ─── sendTelegramFile: retry cap paths ────────────────

test('sendTelegramFile: bails when retry_after exceeds MAX_DELAY cap', async () => {
    // retry_after=60s > MAX_DELAY_MS(30s) → immediate failure
    const bot = mockBot({ failTimes: 3, errorCode: 429, retryAfter: 60 });
    const f = tmpFile(0);
    try {
        const r = await sendTelegramFile(bot, 123, f, 'document');
        assert.equal(r.ok, false);
        assert.equal(r.attempts, 1);
        assert.equal(r.statusCode, 429);
        assert.ok(r.error?.includes('too large'));
    } finally { cleanup(f); }
});

test('sendTelegramFile: retry count stays within MAX_RETRIES bound on transient errors', async () => {
    // Verifies the invariant: total attempts never exceed MAX_RETRIES (3).
    // Note: actual MAX_TOTAL_WAIT cap (60s) isn't tested here because it
    // requires retry_after≥30s which would make the test too slow.
    const bot = mockBot({ failTimes: 3, errorCode: 500 });
    const f = tmpFile(0);
    try {
        const r = await sendTelegramFile(bot, 123, f, 'document');
        assert.equal(r.ok, false);
        assert.ok(r.attempts <= 3, 'attempts should not exceed MAX_RETRIES');
    } finally { cleanup(f); }
});

// ─── classifyUpstreamError ────────────────────────────

test('classifyUpstreamError: 429 → 429', () => {
    assert.equal(classifyUpstreamError({ error_code: 429 }), 429);
});

test('classifyUpstreamError: 500 → 502', () => {
    assert.equal(classifyUpstreamError({ error_code: 500 }), 502);
});

test('classifyUpstreamError: network error → 502', () => {
    assert.equal(classifyUpstreamError({}), 502);
});

// ─── TELEGRAM_LIMITS constants ────────────────────────

test('TELEGRAM_LIMITS matches Bot API docs', () => {
    assert.equal(TELEGRAM_LIMITS.document, 50 * 1024 * 1024);
    assert.equal(TELEGRAM_LIMITS.photo, 10 * 1024 * 1024);
    assert.equal(TELEGRAM_LIMITS.voice, 50 * 1024 * 1024);
});
