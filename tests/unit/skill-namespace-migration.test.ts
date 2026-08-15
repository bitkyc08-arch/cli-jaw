// The jaw-* namespace migration must converge on EVERY home a machine has,
// not just the one a command happened to touch. A pre-rename install keeps
// legacy directories in skills/ AND skills_ref/, and the reference tree is the
// one that matters most: activation, propagation, soft reset, and
// `skill install` all copy skills_ref/<id> -> skills/<id> by exact id, so a
// legacy reference tree re-creates legacy active directories forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import {
    migrateAllJawHomes,
    hasPendingLegacySkillDirs,
    discoverJawHomes,
    normalizeSkillNamespace,
} from '../../lib/mcp/skills-migration.ts';

function makeSkill(dir: string, id: string, body = ''): void {
    fs.mkdirSync(join(dir, id), { recursive: true });
    fs.writeFileSync(join(dir, id, 'SKILL.md'), body || `---\nname: ${id}\n---\n`);
}

function makeHome(root: string, name: string, opts: { active?: string[]; ref?: string[] } = {}): string {
    const home = join(root, name);
    fs.mkdirSync(join(home, 'skills'), { recursive: true });
    fs.mkdirSync(join(home, 'skills_ref'), { recursive: true });
    for (const id of opts.active ?? []) makeSkill(join(home, 'skills'), id);
    for (const id of opts.ref ?? []) makeSkill(join(home, 'skills_ref'), id);
    return home;
}

function withBox<T>(fn: (root: string) => T): T {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'jaw-ns-'));
    try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('SNM-001: the reference tree is renamed, not left on legacy ids', () => {
    withBox(root => {
        const home = makeHome(root, '.cli-jaw', { ref: ['browser', 'dev-frontend'] });
        normalizeSkillNamespace(join(home, 'skills'), home, join(home, 'skills_ref'));

        const ref = join(home, 'skills_ref');
        assert.equal(fs.existsSync(join(ref, 'jaw-browser', 'SKILL.md')), true);
        assert.equal(fs.existsSync(join(ref, 'jaw-dev-frontend', 'SKILL.md')), true);
        assert.equal(fs.existsSync(join(ref, 'browser')), false, 'legacy ref dir must be gone');
        assert.equal(fs.existsSync(join(ref, 'dev-frontend')), false);
    });
});

test('SNM-002: an edited legacy active skill is renamed, carrying the edit forward', () => {
    withBox(root => {
        const home = makeHome(root, '.cli-jaw');
        makeSkill(join(home, 'skills'), 'browser', 'MY EDIT\n');
        normalizeSkillNamespace(join(home, 'skills'), home, join(home, 'skills_ref'));

        const canonical = join(home, 'skills', 'jaw-browser', 'SKILL.md');
        assert.equal(fs.readFileSync(canonical, 'utf8'), 'MY EDIT\n',
            'renaming keeps the edit; backing it up would strand it');
        // and the literal legacy path still resolves through the compat link
        assert.equal(fs.readFileSync(join(home, 'skills', 'browser', 'SKILL.md'), 'utf8'), 'MY EDIT\n');
        assert.equal(fs.lstatSync(join(home, 'skills', 'browser')).isSymbolicLink(), true);
    });
});

test('SNM-003: when both ids exist the canonical wins and the legacy copy is backed up', () => {
    withBox(root => {
        const home = makeHome(root, '.cli-jaw');
        makeSkill(join(home, 'skills'), 'jaw-browser', 'CANONICAL\n');
        makeSkill(join(home, 'skills'), 'browser', 'STALE\n');
        normalizeSkillNamespace(join(home, 'skills'), home, join(home, 'skills_ref'));

        assert.equal(fs.readFileSync(join(home, 'skills', 'jaw-browser', 'SKILL.md'), 'utf8'), 'CANONICAL\n');
        let stale = 0;
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = join(d, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.isFile() && fs.readFileSync(p, 'utf8').includes('STALE')) stale++;
            }
        };
        walk(join(home, 'backups'));
        assert.equal(stale, 1, 'the stale copy is preserved, never deleted');
    });
});

test('SNM-004: every ~/.cli-jaw-* instance is migrated, not only the base home', () => {
    withBox(root => {
        makeHome(root, '.cli-jaw', { ref: ['browser'] });
        makeHome(root, '.cli-jaw-3457', { active: ['browser', 'dev'], ref: ['browser', 'dev'] });
        makeHome(root, '.cli-jaw-manager', { active: ['search'], ref: ['search'] });

        const base = join(root, '.cli-jaw');
        assert.equal(discoverJawHomes(base).length, 3);
        assert.equal(hasPendingLegacySkillDirs(base), true);

        migrateAllJawHomes(base);

        assert.equal(hasPendingLegacySkillDirs(base), false, 'no home may be left behind');
        assert.equal(fs.existsSync(join(root, '.cli-jaw-3457', 'skills', 'jaw-dev', 'SKILL.md')), true);
        assert.equal(fs.existsSync(join(root, '.cli-jaw-manager', 'skills_ref', 'jaw-search', 'SKILL.md')), true);
    });
});

test('SNM-005: user-authored skills are never touched', () => {
    withBox(root => {
        const home = makeHome(root, '.cli-jaw');
        makeSkill(join(home, 'skills'), 'my-thing', 'MINE\n');
        migrateAllJawHomes(home);
        assert.equal(fs.readFileSync(join(home, 'skills', 'my-thing', 'SKILL.md'), 'utf8'), 'MINE\n');
    });
});

test('SNM-006: migration is idempotent', () => {
    withBox(root => {
        const home = makeHome(root, '.cli-jaw', { active: ['browser'], ref: ['browser'] });
        assert.equal(migrateAllJawHomes(home).length, 1, 'first pass does work');
        assert.equal(migrateAllJawHomes(home).length, 0, 'second pass is a no-op');
        assert.equal(hasPendingLegacySkillDirs(home), false);
    });
});

