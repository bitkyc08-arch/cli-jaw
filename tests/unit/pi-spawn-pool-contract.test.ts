import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Pi spawn keeps employees per-turn and sends boss turns through the pool lease', async () => {
    const source = await readFile(new URL('../../src/agent/spawn.ts', import.meta.url), 'utf8');
    const branch = source.slice(source.indexOf("if (cli === 'pi')"), source.indexOf("if (cli === 'codex-app')"));
    const employee = branch.indexOf('if (opts.agentId)');
    const directSpawn = branch.indexOf('spawnPiRpc(', employee);
    const pooledAcquire = branch.indexOf('acquirePiRuntime({', employee);
    assert.ok(employee > 0 && directSpawn > employee && pooledAcquire > directSpawn);
    assert.match(branch, /lease\.session\.sendPrompt/);
    // The kill path used to log a per-CLI literal (`cli=pi action=lease.cancel`).
    // Commit 211531d6 scoped main execution state and merged codex-app/pi into one
    // branch that interpolates the active CLI, so assert the surviving contract:
    // a pi turn registers a cancel hook, and the shared kill path routes pi
    // through it as a lease cancel.
    assert.match(branch, /mainRun\.cancelTurn\s*=\s*cancelHook/);
    assert.match(source, /getActiveMainCli\(scopeKey\)\s*===\s*'pi'/);
    assert.match(source, /action=lease\.cancel/);
});
