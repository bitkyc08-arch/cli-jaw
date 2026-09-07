import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyJawCeoDocsEdit, buildJawCeoDocsEditPolicy } from '../../src/jaw-ceo/docs-edit.ts';

test('docs edits create only approved target parents and never invent a worklog directory', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'jaw-docs-edit-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const policy = buildJawCeoDocsEditPolicy({ repoRoot: root, dashboardNotesRoot: path.join(root, 'notes') });
    const edit = (targetPath: string) => applyJawCeoDocsEdit({
        targetPath, operation: 'append_section', content: '## Update\nReady.', policy,
    });

    await writeFile(path.join(root, 'README.md'), '# Project\n');
    await edit(path.join(root, 'README.md'));
    assert.match(await readFile(path.join(root, 'README.md'), 'utf8'), /## Update/);
    for (const directory of ['devlog', 'docs', 'notes']) {
        assert.equal(existsSync(path.join(root, directory)), false, `${directory} must not be created by policy resolution`);
    }

    await edit(path.join(root, 'docs', 'nested', 'guide.md'));
    assert.match(await readFile(path.join(root, 'docs', 'nested', 'guide.md'), 'utf8'), /Ready/);
    assert.equal(existsSync(path.join(root, 'devlog')), false);
    assert.equal(existsSync(path.join(root, 'notes')), false);
    await edit(path.join(root, 'notes', 'note.md'));
    assert.match(await readFile(path.join(root, 'notes', 'note.md'), 'utf8'), /Ready/);
});

test('denied docs edits and symlink escapes have no directory-creation side effects', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'jaw-docs-denied-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const policy = buildJawCeoDocsEditPolicy({ repoRoot: root, dashboardNotesRoot: path.join(root, 'notes') });
    const edit = (targetPath: string) => applyJawCeoDocsEdit({
        targetPath, operation: 'apply_patch', content: '# Forbidden', policy,
    });
    for (const directory of ['devlog', 'unapproved']) {
        await assert.rejects(edit(path.join(root, directory, 'nested', 'plan.md')), { code: 'docs_edit_root_denied' });
        assert.equal(existsSync(path.join(root, directory)), false);
    }
    await assert.rejects(edit(path.join(root, 'src', 'new.ts')), { code: 'docs_edit_code_path_denied' });
    assert.equal(existsSync(path.join(root, 'src')), false);

    // Create docs through its public edit API, then exercise both live and dangling links.
    await edit(path.join(root, 'docs', 'guide.md'));
    await writeFile(path.join(root, 'outside.md'), '# Original');
    await symlink(path.join(root, 'outside.md'), path.join(root, 'docs', 'linked.md'));
    await assert.rejects(edit(path.join(root, 'docs', 'linked.md')), { code: 'docs_edit_root_denied' });
    assert.equal(await readFile(path.join(root, 'outside.md'), 'utf8'), '# Original');
    await symlink(path.join(root, 'absent.md'), path.join(root, 'docs', 'dangling.md'));
    await assert.rejects(edit(path.join(root, 'docs', 'dangling.md')));
    assert.equal(existsSync(path.join(root, 'absent.md')), false);
});
