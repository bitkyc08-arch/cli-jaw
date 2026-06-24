import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
