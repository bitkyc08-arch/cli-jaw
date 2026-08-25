// #452: "reset everything" only reset things older than a day.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');
const dbSrc = fs.readFileSync(join(root, 'src/core/db.ts'), 'utf8');
const routeSrc = fs.readFileSync(join(root, 'src/routes/orchestrate.ts'), 'utf8');
const machineSrc = fs.readFileSync(join(root, 'src/orchestrator/state-machine.ts'), 'utf8');

test('RESET-452a: the full reset statement has no age filter', () => {
    const stmt = dbSrc.slice(dbSrc.indexOf('resetEveryOrcState'));
    const sql = stmt.slice(0, stmt.indexOf(');'));
    assert.match(sql, /state != 'IDLE'/);
    assert.doesNotMatch(sql, /24 hours/,
        'an age filter here would recreate the bug: the workers a stuck phase '
        + 'waits on died with the previous process, and no amount of waiting '
        + 'brings them back');
});

test('RESET-452b: the stale variant keeps its age filter', () => {
    // Boot still uses this one, and sparing a live cycle on restart is correct
    // there — the two callers want different things.
    const stmt = dbSrc.slice(dbSrc.indexOf('resetAllOrcStates'));
    const sql = stmt.slice(0, stmt.indexOf(');'));
    assert.match(sql, /24 hours/);
});

test('RESET-452c: ?all=true calls the unconditional reset', () => {
    const handler = routeSrc.slice(routeSrc.indexOf("'/api/orchestrate/reset'"));
    const body = handler.slice(0, 900);
    assert.match(body, /resetEveryState\(\)/);
    assert.doesNotMatch(body, /resetAllStaleStates\(\)/,
        'the parameter is named all — it must not quietly mean "some"');
});

test('RESET-452d: boot still prefers the stale-only reset', () => {
    const serverSrc = fs.readFileSync(join(root, 'server.ts'), 'utf8');
    if (!serverSrc.includes('resetAllStaleStates')) return;
    assert.doesNotMatch(serverSrc, /resetEveryState\(\)/,
        'startup must not wipe a cycle a restart could legitimately resume');
    assert.match(machineSrc, /export function resetAllStaleStates/);
});

