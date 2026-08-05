import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JAW_HOME, SETTINGS_PATH, loadSettings, migrateSettings } from '../../src/core/config.ts';

// 110 — turning sessions on by default must not turn them on for anyone who did not ask.
// Every case here is a document shape a real install can be in, and the thing being
// checked is always the same: did this user consent, and does the result match.

function writeSettings(doc: Record<string, unknown>): void {
    fs.mkdirSync(JAW_HOME, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(doc), 'utf8');
}

function load(): Record<string, any> {
    return loadSettings() as Record<string, any>;
}

const V2_BASE = { settingsSchemaVersion: 2, cli: 'codex-app', runtimeDefaultMigration: null };

afterEach(() => {
    try { fs.unlinkSync(SETTINGS_PATH); } catch { /* already gone */ }
    for (const name of fs.readdirSync(JAW_HOME)) {
        if (name.startsWith('settings.json.corrupt-')) {
            try { fs.unlinkSync(`${JAW_HOME}/${name}`); } catch { /* best effort */ }
        }
    }
});

// ON-25 / ON-26 — a document written before this schema keeps what it had, whichever of
// the three shapes it is in. The merge runs before the migration, so an absent key is
// indistinguishable from a written one by then; the baseline is what preserves it.
test('ON-26: a v2 document with only midRunPolicy stays off and keeps its policy', () => {
    writeSettings({ ...V2_BASE, multiSession: { midRunPolicy: 'collect' } });
    const s = load();
    assert.equal(s["multiSession"].enabled, false);
    assert.equal(s["multiSession"].maxConcurrent, 1);
    assert.equal(s["multiSession"].midRunPolicy, 'collect');
    assert.equal(s["multiSessionDefaultMigration"].state, 'pending');
});

test('ON-25: a v2 document with no multiSession block at all stays off', () => {
    writeSettings(V2_BASE);
    const s = load();
    assert.equal(s["multiSession"].enabled, false);
    assert.equal(s["multiSession"].maxConcurrent, 1);
    assert.equal(s["multiSessionDefaultMigration"].state, 'pending');
});

test('ON-25: an explicit false is still false, and still asked about', () => {
    writeSettings({ ...V2_BASE, multiSession: { enabled: false } });
    const s = load();
    assert.equal(s["multiSession"].enabled, false);
    assert.equal(s["multiSessionDefaultMigration"].state, 'pending');
});

// Someone who opted in before this existed already made the decision.
test('a v2 document with sessions already on is not asked', () => {
    writeSettings({ ...V2_BASE, multiSession: { enabled: true, maxConcurrent: 4 } });
    const s = load();
    assert.equal(s["multiSession"].enabled, true);
    assert.equal(s["multiSession"].maxConcurrent, 4, 'a concurrency they chose is theirs');
    assert.equal(s["multiSessionDefaultMigration"].state, 'already-enabled');
});

// ON-27 — the case with no recovery once shipped: a document claiming this schema but
// missing the block would inherit the new defaults and run with sessions on while its
// own marker still said the user had not consented.
test('ON-27: a current-schema document missing its multiSession block does not turn on', () => {
    writeSettings({
        settingsSchemaVersion: 3,
        cli: 'codex-app',
        runtimeDefaultMigration: null,
        multiSessionDefaultMigration: { id: 'multi-session-default-v3', state: 'pending' },
    });
    const s = load();
    assert.equal(s["multiSession"].enabled, false, 'a pending consent must not be running already');
    assert.equal(s["multiSession"].maxConcurrent, 1);
});

// ON-28 — the same rule for every other way that document can be wrong.
for (const [label, block] of [
    ['a string', 'yes'],
    ['an array', []],
    ['null', null],
    ['missing enabled', { maxConcurrent: 2 }],
    ['a zero concurrency', { enabled: true, maxConcurrent: 0 }],
    ['channels as a string', { enabled: true, maxConcurrent: 2, channels: 'all' }],
] as Array<[string, unknown]>) {
    test(`ON-28: a current-schema document with multiSession as ${label} fails closed`, () => {
        writeSettings({
            settingsSchemaVersion: 3,
            cli: 'codex-app',
            runtimeDefaultMigration: null,
            multiSessionDefaultMigration: { id: 'multi-session-default-v3', state: 'pending' },
            multiSession: block,
        });
        const s = load();
        assert.equal(s["multiSession"].enabled, false);
        assert.equal(s["multiSession"].maxConcurrent, 1);
    });
}

test('ON-28: a current-schema document with no marker fails closed', () => {
    writeSettings({
        settingsSchemaVersion: 3,
        cli: 'codex-app',
        runtimeDefaultMigration: null,
        multiSession: { enabled: true, maxConcurrent: 2, midRunPolicy: 'steer' },
    });
    const s = load();
    assert.equal(s["multiSession"].enabled, false, 'this schema always writes the marker');
});

// ON-07 / ON-29 — a genuinely new install has no prior state to preserve and nothing to
// ask about, and that has to survive the first save.
test('ON-29: a fresh install starts on and stays on across a restart', () => {
    try { fs.unlinkSync(SETTINGS_PATH); } catch { /* expected */ }
    const first = load();
    assert.equal(first["multiSession"].enabled, true);
    assert.equal(first["multiSession"].maxConcurrent, 2);
    assert.equal(first["multiSessionDefaultMigration"], null, 'nothing to migrate from');

    const second = load();
    assert.equal(second["multiSession"].enabled, true);
    assert.equal(second["multiSession"].maxConcurrent, 2);
});

// ON-08 — a document we could not read stands in for an unknown prior state, so it gets
// the old meaning rather than the new default.
test('ON-08: an unreadable document falls back to sessions off', () => {
    fs.mkdirSync(JAW_HOME, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, '{ this is not json', 'utf8');
    const s = load();
    assert.equal(s["multiSession"].enabled, false);
    assert.equal(s["multiSession"].maxConcurrent, 1);
});

// ON-35 — migrateSettings can be reached without the boot merge, and it cannot see which
// cohort its argument came from. The old defaults are the only safe answer there.
test('ON-35: migrateSettings given a partial block does not invent the new defaults', () => {
    const s = migrateSettings({ multiSession: { midRunPolicy: 'steer' } }) as Record<string, any>;
    assert.equal(s["multiSession"].enabled, false);
    assert.equal(s["multiSession"].maxConcurrent, 1);
});
