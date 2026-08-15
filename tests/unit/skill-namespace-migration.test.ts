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
import { CODEX_ACTIVE, OPENCLAW_ACTIVE } from '../../lib/mcp/skills-utils.ts';

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

test('SNM-007: a dangling compat link never eats the legacy directory', () => {
    // fs.existsSync FOLLOWS symlinks, so a compat link whose target does not
    // exist yet reads as absent. Deciding occupancy with existsSync made
    // renameSync overwrite the link and destroy the source directory.
    withBox(root => {
        const home = makeHome(root, '.cli-jaw');
        const active = join(home, 'skills');
        makeSkill(active, 'browser', 'REAL CONTENT\n');
        fs.symlinkSync('jaw-browser', join(active, 'jaw-browser'), 'junction');
        assert.equal(fs.existsSync(join(active, 'jaw-browser')), false, 'precondition: link dangles');

        migrateAllJawHomes(home);

        const st = fs.lstatSync(join(active, 'jaw-browser'));
        assert.equal(st.isDirectory(), true, 'the real directory must land on the canonical id');
        assert.equal(st.isSymbolicLink(), false);
        assert.equal(fs.readFileSync(join(active, 'jaw-browser', 'SKILL.md'), 'utf8'), 'REAL CONTENT\n');
    });
});

test('SNM-008: a canonical link pointing back at the legacy dir still converges', () => {
    withBox(root => {
        const home = makeHome(root, '.cli-jaw');
        const active = join(home, 'skills');
        makeSkill(active, 'browser', 'REAL\n');
        fs.symlinkSync('browser', join(active, 'jaw-browser'), 'junction');

        migrateAllJawHomes(home);

        assert.equal(fs.readFileSync(join(active, 'jaw-browser', 'SKILL.md'), 'utf8'), 'REAL\n',
            'the skill must still be usable, not just preserved somewhere');
        assert.equal(hasPendingLegacySkillDirs(home), false);
    });
});

test('SNM-009: a prefix-matching directory that is not a home is left alone', () => {
    // A name is not evidence. `~/.cli-jaw-notes` could be the user's own folder,
    // and the sweep must not write into it.
    withBox(root => {
        const home = makeHome(root, '.cli-jaw');
        const notAHome = join(root, '.cli-jaw-notes');
        fs.mkdirSync(notAHome, { recursive: true });
        fs.writeFileSync(join(notAHome, 'my.txt'), 'mine\n');

        const found = discoverJawHomes(home).map(h => h.split('/').pop());
        assert.deepEqual(found, ['.cli-jaw']);
        assert.equal(fs.readFileSync(join(notAHome, 'my.txt'), 'utf8'), 'mine\n');
    });
});

test('SNM-010: a symlinked prefix match is never followed', () => {
    withBox(root => {
        const home = makeHome(root, '.cli-jaw');
        const elsewhere = join(root, 'elsewhere');
        fs.mkdirSync(join(elsewhere, 'skills'), { recursive: true });
        fs.symlinkSync(elsewhere, join(root, '.cli-jaw-linked'), 'junction');

        assert.deepEqual(discoverJawHomes(home).map(h => h.split('/').pop()), ['.cli-jaw'],
            'a symlink must not decide what the sweep may modify');
    });
});


test('SNM-011: a borrowed (symlinked) reference tree is left to its owner', () => {
    // `jaw clone --link-ref` points a clone at the source home's skills_ref.
    // Migrating through that link writes into a home this sweep does not own
    // and drops backups under the wrong home.
    withBox(root => {
        const owner = makeHome(root, '.cli-jaw', { ref: ['browser'] });
        const clone = join(root, '.cli-jaw-clone');
        fs.mkdirSync(join(clone, 'skills'), { recursive: true });
        fs.symlinkSync(join(owner, 'skills_ref'), join(clone, 'skills_ref'), 'junction');

        migrateAllJawHomes(clone);

        assert.equal(fs.existsSync(join(owner, 'skills_ref', 'browser')), true,
            "the owner's tree must not be migrated through a borrowed link");
        assert.equal(fs.existsSync(join(owner, 'skills_ref', 'jaw-browser')), false);

        // and the clone must not keep reporting work it will never do
        assert.equal(hasPendingLegacySkillDirs(clone), false,
            'a borrowed tree must not leave the clone permanently pending');

        // and the owner still migrates it when ITS home is swept
        migrateAllJawHomes(owner);
        assert.equal(fs.existsSync(join(owner, 'skills_ref', 'jaw-browser')), true);
    });
});

test('SNM-012: a user-owned canonical symlink is never clobbered', () => {
    // Someone may point skills/jaw-browser at their own checkout. Clearing it
    // to make room for a rename would destroy their setup.
    withBox(root => {
        const home = makeHome(root, '.cli-jaw');
        const active = join(home, 'skills');
        const mine = join(root, 'my-checkout');
        fs.mkdirSync(mine, { recursive: true });
        fs.writeFileSync(join(mine, 'SKILL.md'), 'MY CHECKOUT\n');
        fs.symlinkSync(mine, join(active, 'jaw-browser'), 'junction');
        makeSkill(active, 'browser', 'LEGACY\n');

        migrateAllJawHomes(home);

        assert.equal(fs.readFileSync(join(active, 'jaw-browser', 'SKILL.md'), 'utf8'), 'MY CHECKOUT\n',
            'a link pointing outside the tree belongs to the user');
        // the legacy copy is preserved, never silently dropped
        let kept = 0;
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = join(d, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.isFile() && fs.readFileSync(p, 'utf8').includes('LEGACY')) kept++;
            }
        };
        walk(join(home, 'backups'));
        assert.equal(kept, 1);
    });
});

test('SNM-013: a stale compat link is reported as pending, not silently skipped', () => {
    // The detector has to agree with what the migrators repair, or doctor
    // reports clean while skills/browser points at nothing.
    withBox(root => {
        const home = makeHome(root, '.cli-jaw');
        const active = join(home, 'skills');
        makeSkill(active, 'jaw-browser');
        fs.symlinkSync('nowhere', join(active, 'browser'), 'junction');

        assert.equal(hasPendingLegacySkillDirs(home), true, 'a dangling compat link is work');
        migrateAllJawHomes(home);
        assert.equal(hasPendingLegacySkillDirs(home), false);
        assert.equal(fs.readFileSync(join(active, 'browser', 'SKILL.md'), 'utf8').length > 0, true);
    });
});

test('SNM-014: a correct compat link is stable across passes', () => {
    // pointsAt resolves the target instead of string-comparing it. A literal
    // compare breaks on Windows, where a junction reads back absolute, and the
    // link would be unlinked and recreated on every single pass.
    withBox(root => {
        const home = makeHome(root, '.cli-jaw');
        makeSkill(join(home, 'skills'), 'browser', 'X\n');
        migrateAllJawHomes(home);

        const link = join(home, 'skills', 'browser');
        const before = fs.lstatSync(link);
        assert.equal(before.isSymbolicLink(), true);
        assert.equal(migrateAllJawHomes(home).length, 0, 'a settled home needs no work');
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link must survive untouched');
    });
});

// The desktop app ships its own CommonJS copy of this migration. It cannot be
// imported (it runs as a process and needs packaging assets absent from a
// source checkout), and it has drifted before — its default set was 14 of 17
// ids. These pin the invariants that actually bit us, the same way
// desktop-control-skill-contract.test.ts pins the shipped skill.
const CJS = fs.readFileSync(join(
    import.meta.dirname, '..', '..',
    'electron/sidecar/jawcode/packages/jwc/scripts/bootstrap-cli-jaw-home.cjs',
), 'utf8');

test('SNM-015: the Electron migrator does the reference tree, and does it first', () => {
    assert.match(CJS, /function migrateRefNamespace\(\)/,
        'a legacy reference tree re-creates legacy active dirs forever');
    const call = CJS.indexOf('migrateRefNamespace();');
    const activeLoop = CJS.indexOf('for (const [legacyId, canonicalId] of LEGACY_SKILL_ALIASES) {', call);
    assert.ok(call > 0 && activeLoop > call,
        'the reference tree must be migrated before the active tree');
});

test('SNM-016: the Electron migrator refuses a borrowed reference tree', () => {
    const body = CJS.slice(CJS.indexOf('function migrateRefNamespace()'));
    assert.match(body.slice(0, 700), /isSymbolicLink\(\)\) return;/,
        'migrating through a symlinked skills_ref writes into another home');
});

test('SNM-017: the Electron migrator renames rather than always backing up', () => {
    assert.match(CJS, /legacy skill migrated: \$\{legacyId\} -> \$\{canonicalId\}/,
        'always backing up empties the active tree and strands in-place edits');
    assert.match(CJS, /function canonicalIsBlocked\(/);
    assert.match(CJS, /function isOwnedCompatLink\(/,
        'a link pointing outside the tree belongs to the user');
});

test('SNM-018: the Electron migrator resolves link targets instead of string-comparing', () => {
    assert.match(CJS, /function linkPointsAt\(/);
    assert.doesNotMatch(CJS, /current === canonicalId/,
        'a Windows junction reads back absolute, so a literal compare churns every pass');
});

test('SNM-019: the Electron default set matches the runtime active set', () => {
    // It shipped with 14 of 17, so the desktop app activated 27 skills where
    // the CLI activated 30.
    const base = CJS.slice(CJS.indexOf('const BASE_AUTO_ACTIVATE'), CJS.indexOf(']);', CJS.indexOf('const BASE_AUTO_ACTIVATE')));
    const ids = [...base.matchAll(/"(jaw-[a-z-]+)"/g)].map(m => m[1]).sort();
    const expected = [...CODEX_ACTIVE, ...OPENCLAW_ACTIVE].sort();
    assert.deepEqual(ids, expected);
});
