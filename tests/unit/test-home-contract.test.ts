import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '../..');
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const setupSrc = readFileSync(join(projectRoot, 'tests/setup/test-home.ts'), 'utf8');

test('THC-001: test setup overrides inherited CLI_JAW_HOME before DB import', () => {
    assert.ok(setupSrc.includes('CLI_JAW_INHERITED_HOME'), 'setup should preserve inherited home for diagnostics');
    assert.ok(setupSrc.includes("process.env.CLI_JAW_HOME = testHome"), 'setup should override CLI_JAW_HOME to temp home');
    assert.ok(!setupSrc.includes("throw new Error(`Refusing to run tests against live CLI_JAW_HOME"),
        'setup must not throw before overriding inherited live home');
});

test('THC-002: DB-touching aggregate test scripts preload test home', () => {
    // Aggregate gates preload test-home either via the --import flag or by running
    // through the tests/run.mts driver, which imports tests/setup/test-home.ts as
    // its first line (node:test --test is unusable under tsx; see tests/run.mts).
    const runnerSrc = readFileSync(join(projectRoot, 'tests/run.mts'), 'utf8');
    const runnerPreloads = runnerSrc.includes('setup/test-home.ts');
    for (const name of ['test', 'test:all', 'test:coverage', 'test:watch']) {
        const script = packageJson.scripts[name] ?? '';
        const viaImport = script.includes('--import ./tests/setup/test-home.ts');
        const viaRunner = script.includes('tests/run.mts') && runnerPreloads;
        assert.ok(viaImport || viaRunner,
            `${name} should preload tests/setup/test-home.ts (via --import or the tests/run.mts driver)`);
    }
});

test('THC-003: parser-only and smoke scripts are not forced through test-home preload', () => {
    for (const name of ['test:events', 'test:telegram', 'test:smoke']) {
        assert.ok(!packageJson.scripts[name]?.includes('--import ./tests/setup/test-home.ts'),
            `${name} should keep its existing specialized test policy`);
    }
});

test('THC-004: every test file that writes orc_state owns an isolated CLI_JAW_HOME (#458)', () => {
    // Not a source-regex on product code — this is a repo invariant about the test
    // harness itself. tests/run.mts forks per file but shares ONE CLI_JAW_HOME, so
    // two files that both write the 'default' orc_state row race each other and the
    // loser reads the winner's phase (actual: 'IDLE', expected: 'P').
    const unitDir = join(projectRoot, 'tests/unit');
    const offenders: string[] = [];
    for (const name of readdirSync(unitDir)) {
        if (!name.endsWith('.test.ts')) continue;
        const src = readFileSync(join(unitDir, name), 'utf8');
        if (!/from\s+'[^']*orchestrator\/state-machine[^']*'/.test(src)) continue;
        // Only files that MUTATE the shared row matter. Strip comments AND string
        // literals first: the source-inspection tests quote "resetState(scope)" as
        // an assertion needle without ever calling it.
        const code = src
            .replace(/^\s*\/\/.*$/gm, '')
            .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
            .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
            .replace(/`(?:[^\\`]|\\.)*`/g, '``');
        if (!/\b(setState|resetState)\s*\(/.test(code)) continue;
        if (!src.includes('setup/isolated-home')) offenders.push(name);
    }
    assert.deepEqual(offenders, [],
        "these files mutate the shared orc_state row without an isolated home; add import '../setup/isolated-home.ts' as the FIRST import");
});
