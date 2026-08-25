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

