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
    assert.match(source, /cli=pi action=lease\.cancel/);
});
