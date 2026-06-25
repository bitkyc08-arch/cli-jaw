import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    validateProjectSourcesUrl,
    validateProjectSourceFiles,
    buildProjectSourcesListExpression,
    buildProjectSourcesUploadEvidenceExpression,
    addProjectSource,
    type CdpSendSession,
} from '../../src/browser/web-ai/chatgpt-project-sources.ts';

// 102 chatgpt-project-sources: URL + file validation, evidence expressions, dry-run.
test('BWAI-PROJSRC-001: validateProjectSourcesUrl accepts only /g/<id> project URLs', () => {
    assert.deepEqual(validateProjectSourcesUrl('https://chatgpt.com/g/g-abc_123'), { ok: true });
    assert.equal(validateProjectSourcesUrl('https://chatgpt.com/c/abc').ok, false);
    assert.equal(validateProjectSourcesUrl('https://example.com/g/x').ok, false);
    assert.match(validateProjectSourcesUrl('').error!, /required/);
});

test('BWAI-PROJSRC-002: validateProjectSourceFiles flags missing files and size cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'projsrc-'));
    const good = join(dir, 'a.txt');
    writeFileSync(good, 'hello');

    const ok = validateProjectSourceFiles([good]);
    assert.equal(ok.errors.length, 0);
    assert.equal(ok.valid.length, 1);
    assert.equal(ok.valid[0]!.name, 'a.txt');
    assert.equal(ok.valid[0]!.size, 5);

    const missing = validateProjectSourceFiles([join(dir, 'nope.txt')]);
    assert.equal(missing.valid.length, 0);
    assert.match(missing.errors[0]!, /file not found/);

    const tooBig = validateProjectSourceFiles([good], { maxFileSize: 1 });
    assert.equal(tooBig.valid.length, 0);
    assert.match(tooBig.errors[0]!, /file too large/);
});

test('BWAI-PROJSRC-003: list expression carries the source-entry selectors', () => {
    const expr = buildProjectSourcesListExpression();
    assert.match(expr, /project-source-item/);
    assert.match(expr, /data-type/);
});

test('BWAI-PROJSRC-004: upload-evidence expression embeds expected filenames + ok rule', () => {
    const expr = buildProjectSourcesUploadEvidenceExpression(['a.txt', 'b.pdf']);
    assert.match(expr, /"a\.txt"/);
    assert.match(expr, /"b\.pdf"/);
    assert.match(expr, /inputFileCount/);
    assert.match(expr, /present\.length === expected\.length/);
});

test('BWAI-PROJSRC-005: addProjectSource rejects a bad URL before touching CDP', async () => {
    let sent = false;
    const cdp: CdpSendSession = { async send() { sent = true; return {}; } };
    const r = await addProjectSource(cdp, { projectUrl: 'https://chatgpt.com/c/x', filePaths: [] });
    assert.equal(r.ok, false);
    assert.match(r.errors[0]!, /not a valid ChatGPT project URL/);
    assert.equal(sent, false, 'no CDP traffic on invalid url');
});

test('BWAI-PROJSRC-006: addProjectSource dry-run lists files without uploading', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'projsrc-'));
    const good = join(dir, 'doc.txt');
    writeFileSync(good, 'x');
    const cdp: CdpSendSession = { async send() { throw new Error('should not send in dry-run'); } };
    const r = await addProjectSource(cdp, { projectUrl: 'https://chatgpt.com/g/g-abc', filePaths: [good], dryRun: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.uploads, [{ name: 'doc.txt', type: 'file', uploaded: false }]);
    assert.deepEqual(r.warnings, ['dry-run-no-upload']);
});
