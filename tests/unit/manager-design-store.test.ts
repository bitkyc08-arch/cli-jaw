/**
 * 186 Phase 2 -- Design filesystem store.
 *
 * - create/list/get round-trip under a temp dashboard home
 * - path traversal + write allowlist rejection
 * - invalid page.json -> schema warning, never deleted
 * - direct artifact.html edit -> rescan/list recovery
 * - baseRevision conflict (409 source)
 * - snapshot before/after + restore creates a recovery snapshot
 * - export confined to the bound projectDir, no-overwrite by default
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['CLI_JAW_DASHBOARD_HOME'] = mkdtempSync(join(tmpdir(), 'jaw-design-store-'));

const {
    createDesignPage,
    getDesignPage,
    listDesignPages,
    listDesignPageSnapshots,
    localPathsForPage,
    patchDesignPage,
    projectKeyDirName,
    readDesignPageFile,
    rescanDesignPages,
    restoreDesignPageSnapshot,
    snapshotDesignPage,
    exportDesignPage,
    writeDesignPageFile,
} = await import('../../src/manager/design/store.js');

const projectDir = mkdtempSync(join(tmpdir(), 'jaw-design-project-'));

test('create/list/get round-trip', () => {
    const page = createDesignPage({ title: 'Landing hero', projectKey: projectDir });
    assert.ok(page.id.startsWith('page-'));
    assert.equal(page.title, 'Landing hero');
    assert.equal(page.revision, 1);
    assert.equal(page.schemaWarning, null);

    const listed = listDesignPages(projectDir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, page.id);

    const detail = getDesignPage(page.id);
    assert.equal(detail.projectKey, projectDir);
    assert.equal(detail.exportTarget, null);

    const paths = localPathsForPage(page.id);
    assert.ok(existsSync(paths.artifactPath));
    assert.ok(paths.pageDir.includes(projectKeyDirName(projectDir)));
});

test('projectKeyDirName is stable and filesystem-safe', () => {
    const key = projectKeyDirName('/Users/x/My Project!!');
    assert.match(key, /^[a-z0-9-_]+-[0-9a-f]{8}$/);
    assert.equal(key, projectKeyDirName('/Users/x/My Project!!'));
    assert.equal(projectKeyDirName(null), 'default');
});

test('path traversal and write allowlist are enforced', () => {
    const page = createDesignPage({ title: 'Guarded', projectKey: projectDir });
    assert.throws(() => readDesignPageFile(page.id, '../other/page.json'), /unsafe path/);
    assert.throws(() => readDesignPageFile(page.id, '/etc/passwd'), /unsafe path/);
    assert.throws(() => readDesignPageFile(page.id, 'assets\\evil'), /unsafe path/);
    const denied = writeDesignPageFile(page.id, 'notes.txt', 'x', getDesignPage(page.id).revision);
    assert.equal(denied.ok, false);
    assert.match((denied as { error: string }).error, /not writable/);
});

test('symlinked paths inside a page are rejected', () => {
    const page = createDesignPage({ title: 'Symlinked', projectKey: projectDir });
    const paths = localPathsForPage(page.id);
    const outside = mkdtempSync(join(tmpdir(), 'jaw-design-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(paths.pageDir, 'assets', 'link.txt'));
    assert.throws(() => readDesignPageFile(page.id, 'assets/link.txt'), /symlink|escapes/);
});

test('invalid page.json keeps the page with a schema warning', () => {
    const page = createDesignPage({ title: 'Broken soon', projectKey: projectDir });
    const paths = localPathsForPage(page.id);
    writeFileSync(join(paths.pageDir, 'page.json'), '{ definitely not json');
    const listed = listDesignPages(projectDir);
    const broken = listed.find(entry => entry.id === page.id);
    assert.ok(broken, 'page still listed');
    assert.ok(broken!.schemaWarning, 'schema warning surfaced');
    assert.ok(existsSync(paths.artifactPath), 'artifact untouched');
    const scan = rescanDesignPages(projectDir);
    assert.ok(scan.warnings >= 1);
});

test('direct artifact edit is picked up by read after rescan', () => {
    const page = createDesignPage({ title: 'Direct write', projectKey: projectDir });
    const paths = localPathsForPage(page.id);
    writeFileSync(paths.artifactPath, '<!doctype html><title>edited outside</title>');
    rescanDesignPages(projectDir);
    const read = readDesignPageFile(page.id, 'artifact.html');
    assert.ok(read.content.includes('edited outside'));
});

test('baseRevision mismatch yields a conflict, not a write', () => {
    const page = createDesignPage({ title: 'Conflicted', projectKey: projectDir });
    const first = writeDesignPageFile(page.id, 'artifact.html', '<p>v2</p>', page.revision);
    assert.equal(first.ok, true);
    const stale = writeDesignPageFile(page.id, 'artifact.html', '<p>v2-stale</p>', page.revision);
    assert.equal(stale.ok, false);
    assert.equal((stale as { conflict: true }).conflict, true);
    const patchStale = patchDesignPage(page.id, { title: 'X' }, page.revision);
    assert.equal(patchStale.ok, false);
    assert.equal((patchStale as { conflict: true }).conflict, true);
});

test('snapshots capture and restore with a recovery snapshot', () => {
    const page = createDesignPage({ title: 'Snapshotted', projectKey: projectDir });
    writeDesignPageFile(page.id, 'artifact.html', '<p>original</p>', getDesignPage(page.id).revision);
    const before = snapshotDesignPage(page.id, 'before');
    writeDesignPageFile(page.id, 'artifact.html', '<p>mutated</p>', getDesignPage(page.id).revision);
    const restored = restoreDesignPageSnapshot(page.id, before.id);
    assert.equal(restored.ok, true);
    const read = readDesignPageFile(page.id, 'artifact.html');
    assert.ok(read.content.includes('original'), 'restore brought the snapshot back');
    const snapshots = listDesignPageSnapshots(page.id);
    assert.ok(snapshots.some(s => s.label === 'recovery'), 'restore leaves a recovery snapshot');
});

test('export writes inside the bound projectDir only, no overwrite by default', () => {
    const page = createDesignPage({ title: 'Exported Page', projectKey: projectDir });
    const result = exportDesignPage(page.id);
    assert.equal(result.ok, true);
    const exportedTo = (result as { exportedTo: string }).exportedTo;
    assert.ok(exportedTo.startsWith(projectDir), 'export confined to projectDir');
    assert.ok(readFileSync(exportedTo, 'utf-8').length > 0);

    const again = exportDesignPage(page.id);
    assert.equal(again.ok, false, 'no overwrite by default');
    const forced = exportDesignPage(page.id, undefined, { overwrite: true });
    assert.equal(forced.ok, true);

    const escape = exportDesignPage(page.id, '../outside.html', { overwrite: true });
    assert.equal(escape.ok, false, 'traversal export target rejected');
});

test('export without a bound projectDir fails cleanly', () => {
    const page = createDesignPage({ title: 'Unbound' });
    const result = exportDesignPage(page.id);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /projectDir/);
});

test('unknown page id throws not-found', () => {
    assert.throws(() => getDesignPage('page-does-not-exist'), /not found/);
    // Path-ish ids never resolve
    assert.equal(listDesignPages(projectDir).some(p => p.id.includes('/')), false);
    mkdirSync(join(projectDir, 'noop'), { recursive: true });
});
