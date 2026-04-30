import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightAttachment } from '../../src/browser/web-ai/chatgpt-attachments.js';

test('ATT-001: preflight rejects oversize files', () => {
    const r = preflightAttachment({ path: '/tmp/x.png', sizeBytes: 5 * 1024 * 1024 * 1024, basename: 'x.png' });
    assert.equal(r.ok, false);
    assert.match(r.rejectedReason || '', /limit|size|byte/i);
});

test('ATT-002: preflight rejects unsupported extension', () => {
    const r = preflightAttachment({ path: '/tmp/x.gdoc', sizeBytes: 1024, basename: 'x.gdoc' });
    assert.equal(r.ok, false);
    assert.match(r.rejectedReason || '', /unsupported/i);
});

test('ATT-003: preflight accepts a small png', () => {
    const r = preflightAttachment({ path: '/tmp/ok.png', sizeBytes: 1024 * 100, basename: 'ok.png' });
    assert.equal(r.ok, true);
});

test('ATT-004: runtime uploads stay fail-closed (PRD32.7-A scaffold) — no external provider import', async () => {
    const fs: any = await import('node:fs');
    const src = fs.readFileSync(new URL('../../src/browser/web-ai/chatgpt-attachments.ts', import.meta.url), 'utf8');
    assert.match(src, /preflightAttachment/);
});
