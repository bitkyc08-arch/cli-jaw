import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '../..');
const cliSrc = readFileSync(join(projectRoot, 'bin/commands/orchestrate.ts'), 'utf8');
const dispatchSrc = readFileSync(join(projectRoot, 'bin/commands/dispatch.ts'), 'utf8');
const commandsSrc = readFileSync(join(projectRoot, 'src/cli/commands.ts'), 'utf8');
const handlerSrc = readFileSync(join(projectRoot, 'src/cli/handlers-runtime.ts'), 'utf8');

test('ORC-CLI-001: standalone orchestrate command supports status target', () => {
    assert.ok(cliSrc.includes("'STATUS'"), 'CLI valid target list should include STATUS');
    assert.ok(cliSrc.includes("target === 'STATUS'"), 'CLI should branch status before state transition');
    assert.ok(cliSrc.includes("`${BASE}/api/orchestrate/state`"), 'status should read GET /api/orchestrate/state');
});

test('ORC-CLI-002: standalone orchestrate command parses force/json/port without treating flags as target', () => {
    assert.ok(cliSrc.includes('function parseArgs'), 'CLI should have an argument parser');
    assert.ok(cliSrc.includes("arg === '--force'"), 'CLI parser should recognize --force');
    assert.ok(cliSrc.includes("arg === '--json'"), 'CLI parser should recognize --json');
    assert.ok(cliSrc.includes("arg === '--port'"), 'CLI parser should recognize --port <value>');
    assert.ok(cliSrc.includes("arg?.startsWith('--port=')"), 'CLI parser should recognize --port=<value>');
    assert.ok(cliSrc.includes('positional.push(arg)'), 'CLI parser should keep target separate from flags');
});

test('ORC-CLI-003: standalone force and user approval are sent in state transition body', () => {
    assert.ok(cliSrc.includes('userInitiated: true'), 'standalone CLI transitions should count as explicit user approval');
    assert.ok(cliSrc.includes("...(parsed.force ? { force: true } : {})"), 'PUT body should include force:true when requested');
    assert.ok(!cliSrc.includes('JSON.stringify({ state: target })'), 'old body without force should not remain');
});

test('ORC-CLI-004: transition failures print current server state for operator clarity', () => {
    assert.ok(cliSrc.includes('Current server state:'), 'CLI should print current state after transition failure');
    assert.ok(cliSrc.includes('/api/orchestrate/state'), 'CLI failure path should query current state');
});

test('ORC-CLI-005: slash command and command metadata expose status and force', () => {
    assert.ok(commandsSrc.includes('[P|A|B|C|D|status|reset] [--force]'), 'command metadata should expose status and --force');
    assert.ok(handlerSrc.includes("target === 'STATUS'"), 'slash orchestrate handler should support status');
    assert.ok(handlerSrc.includes('const userInitiated = true'), 'slash orchestrate transitions should count as explicit user approval');
    assert.ok(handlerSrc.includes('const hasExplicitApproval = force || userInitiated'), 'slash handler should apply user approval without requiring --force');
    assert.ok(handlerSrc.includes('Current server state:'), 'slash failure text should include current server state');
});

test('ORC-CLI-006: dispatch CLI polls worker result endpoint for rejoin', () => {
    assert.match(
        dispatchSrc,
        /\/api\/orchestrate\/worker\/\$\{encodeURIComponent\(agentId\)\}\/result/,
        'dispatch CLI should poll worker result endpoint',
    );
    assert.match(dispatchSrc, /pollWorkerResult/, 'dispatch CLI should define a polling helper');
    assert.match(dispatchSrc, /status === 'failed'/, 'failed worker state should exit non-zero');
});
