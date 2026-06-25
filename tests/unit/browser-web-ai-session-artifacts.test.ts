import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Strict-TS port of agbrowse session-artifacts (catalog 101 #7). Uses a fresh temp
// CLI_JAW_HOME so writes land under an isolated artifacts dir.
test('BWAI-ARTIFACTS-001: save helpers write under JAW_HOME with sanitized paths', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cjwa-'));
    process.env.CLI_JAW_HOME = home;
    const art = await import('../../src/browser/web-ai/session-artifacts.js');

    // resolveArtifactsDir sanitizes the session id (no traversal) and roots under home
    const dir = art.resolveArtifactsDir('webai/../../evil id');
    assert.ok(dir.startsWith(home), 'artifacts dir must be under JAW_HOME');
    assert.ok(!dir.includes('..'), 'session id traversal must be sanitized');

    // transcript round-trips to disk
    const t = art.trySaveTranscript('webai_1', '# hi\n\nbody');
    assert.equal(t.ok, true);
    assert.ok(t.ok && t.descriptor.kind === 'transcript' && t.descriptor.sizeBytes === Buffer.byteLength('# hi\n\nbody', 'utf8'));
    if (t.ok) {
        const p = join(art.resolveArtifactsDir('webai_1'), t.descriptor.path);
        assert.equal(readFileSync(p, 'utf8'), '# hi\n\nbody');
    }

    // generic file artifact preserves the extension; image falls back to MIME subtype
    const f = art.trySaveFileArtifact('webai_1', { filename: 'export.csv', buffer: Buffer.from('a,b'), mimeType: 'text/csv' });
    assert.ok(f.ok && f.descriptor.kind === 'file' && f.descriptor.path.endsWith('.csv'));
    const img = art.trySaveImageArtifact('webai_1', { filename: 'pic', buffer: Buffer.from([1, 2, 3]), mimeType: 'image/png' });
    assert.ok(img.ok && img.descriptor.kind === 'image' && img.descriptor.path.endsWith('.png'));

    // report appends a Sources section
    const r = art.trySaveReport('webai_1', { text: 'R', sources: ['https://x'] });
    assert.ok(r.ok && r.descriptor.kind === 'report');
    if (r.ok) {
        const body = readFileSync(join(art.resolveArtifactsDir('webai_1'), r.descriptor.path), 'utf8');
        assert.match(body, /## Sources\n1\. https:\/\/x/);
    }

    // diagnostics writes JSON (+ optional screenshot)
    const d = art.trySaveDiagnosticsArtifact('webai_1', { context: 'send-fail', domJson: { a: 1 }, screenshotBuffer: Buffer.from([9]) });
    assert.ok(d.ok && d.descriptor.kind === 'diagnostics' && typeof d.descriptor.screenshotPath === 'string');
});
