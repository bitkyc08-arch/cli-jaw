// #446: a legacy alias link must not count as a second skill.
//
// On POSIX a symlink already reads as non-directory, so the aliases were skipped
// by accident rather than by rule. The migration creates Windows links with
// symlinkSync(..., 'junction'), and a junction can read as a directory — there the
// same skill appears under both names and the prompt lists it twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dedupeSkillDirEntries } from '../../lib/mcp/skills-utils.ts';

function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'cli-jaw-skills-'));
}

test('SKILL-446a: an alias link is folded into the skill it points at', () => {
    const dir = scratch();
    fs.mkdirSync(join(dir, 'jaw-sample'));
    fs.writeFileSync(join(dir, 'jaw-sample/SKILL.md'), '---\nname: jaw-sample\n---\n');
    try {
        symlinkSync('jaw-sample', join(dir, 'sample'));
    } catch {
        return; // filesystem refuses links; the dedupe rule is covered below
    }

    const names = dedupeSkillDirEntries(dir);
    assert.equal(names.length, 1, `alias counted separately: ${names.join(', ')}`);
    assert.equal(names[0], 'jaw-sample',
        'the canonical directory must survive, not the alias');
});

test('SKILL-446b: two entries resolving to one real path yield one name', () => {
    // Stands in for the Windows junction case, where both entries report as
    // directories and only realpath tells them apart.
    const dir = scratch();
    const real = join(dir, 'jaw-target');
    fs.mkdirSync(real);
    try {
        symlinkSync(real, join(dir, 'alias-one'));
        symlinkSync(real, join(dir, 'alias-two'));
    } catch {
        return;
    }

    assert.equal(dedupeSkillDirEntries(dir).length, 1);
});

test('SKILL-446c: genuinely separate skills are all kept', () => {
    const dir = scratch();
    for (const name of ['jaw-a', 'jaw-b', 'jaw-c']) fs.mkdirSync(join(dir, name));
    assert.deepEqual(dedupeSkillDirEntries(dir).sort(), ['jaw-a', 'jaw-b', 'jaw-c']);
});

test('SKILL-446d: hidden, .bak and _original entries stay excluded', () => {
    const dir = scratch();
    for (const name of ['jaw-real', '.hidden', 'thing.bak', 'thing_original']) {
        fs.mkdirSync(join(dir, name));
    }
    assert.deepEqual(dedupeSkillDirEntries(dir), ['jaw-real']);
});

test('SKILL-446e: a broken link is skipped rather than throwing', () => {
    const dir = scratch();
    try {
        symlinkSync('nowhere', join(dir, 'dangling'));
    } catch {
        return;
    }
    assert.deepEqual(dedupeSkillDirEntries(dir), []);
});

test('SKILL-446f: a missing directory yields an empty list', () => {
    assert.deepEqual(dedupeSkillDirEntries(join(tmpdir(), 'cli-jaw-does-not-exist-446')), []);
});

// ── SKILL-446g: the doctor path counts what the prompt loads (#524) ──
//
// `jaw doctor` used to filter dirents by `isDirectory()`, which is false for a
// POSIX symlink. That skipped alias links by accident on this platform — and it
// also skipped a skill symlinked in from OUTSIDE the directory, so a home whose
// skills are all links reported "skills directory is empty" and told the user to
// re-clone a working install. On Windows the same filter counted junction
// aliases twice. Both are the same defect: the count did not match what
// `loadActiveSkills` actually loads.
//
// Only the COUNT is asserted. Which name survives a fold is readdir order, which
// is not a guarantee this suite should pin.

test('SKILL-446g: skills reachable only through links are counted, not dropped', () => {
    const dir = scratch();
    const store = mkdtempSync(join(tmpdir(), 'cli-jaw-446g-store-'));
    fs.mkdirSync(join(store, 'jaw-outside'));
    fs.writeFileSync(join(store, 'jaw-outside', 'SKILL.md'), '# outside\n');
    fs.mkdirSync(join(dir, 'jaw-real'));
    try {
        symlinkSync(join(store, 'jaw-outside'), join(dir, 'jaw-outside'));
    } catch {
        return; // no symlink privilege (unprivileged Windows); nothing to observe
    }

    const counted = dedupeSkillDirEntries(dir);
    assert.equal(counted.length, 2, 'a skill linked in from outside is a skill, not absent');

    // The shape the old doctor line used, kept here as the contrast that makes
    // the assertion above mean something: it sees one, and a link-only home zero.
    const direntOnly = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());
    assert.equal(direntOnly.length, 1, 'the dirent filter is what made a populated home read as empty');
});

test('SKILL-446h: an in-directory alias folds to one skill', () => {
    const dir = scratch();
    fs.mkdirSync(join(dir, 'jaw-dev'));
    try {
        symlinkSync(join(dir, 'jaw-dev'), join(dir, 'dev'));
    } catch {
        return;
    }
    assert.equal(dedupeSkillDirEntries(dir).length, 1, 'an alias and its target are one skill');
});
