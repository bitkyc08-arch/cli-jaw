/**
 * 186 Phase 4 -- `jaw design` CLI command contract.
 *
 * - the command is registered in bin/cli-jaw.ts (_knownCmds + switch + help)
 * - the command is FILE-FIRST: it imports the design store directly and does
 *   not fetch the manager HTTP API
 * - the v1 surface exists: list/create/show/path/rescan/edit/export/files/catalog
 * - files write requires --stdin; export defaults to no-overwrite
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const cli = readFileSync(join(root, 'bin/cli-jaw.ts'), 'utf-8');
const command = readFileSync(join(root, 'bin/commands/design.ts'), 'utf-8');

test('design command is registered in the CLI entry', () => {
    assert.ok(cli.includes("'design'"), 'design in _knownCmds');
    assert.ok(cli.includes("case 'design':"), 'switch case exists');
    assert.ok(cli.includes("await import('./commands/design.js')"), 'lazy import');
    assert.ok(cli.includes('design <list|create|show|path|...>'), 'help mentions design');
});

test('design command is file-first (store import, no manager HTTP)', () => {
    assert.ok(command.includes("from '../../src/manager/design/store.js'"), 'imports the store directly');
    assert.ok(!command.includes('/api/dashboard/design'), 'no HTTP client fallback in v1 file-first surface');
    assert.ok(!command.includes('getServerUrl'), 'does not require a live server');
});

test('v1 sub-command surface exists', () => {
    for (const sub of ['list', 'create', 'show', 'path', 'rescan', 'edit', 'export', 'files', 'catalog', 'snapshots']) {
        assert.ok(command.includes(`case '${sub}':`), `sub-command ${sub}`);
    }
});

test('argument contract: title required for create, stdin required for write, overwrite is opt-in', () => {
    assert.ok(command.includes("die('--title required')"), 'create validates --title');
    assert.ok(command.includes("die('write requires --stdin"), 'files write requires --stdin');
    assert.ok(command.includes("flag('overwrite')"), 'export overwrite is an explicit flag');
    assert.ok(command.includes("option('project')"), 'list/create/rescan accept --project');
    assert.ok(command.includes('revision conflict'), 'stale write reports the conflict with recovery guidance');
});
