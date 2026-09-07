import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// /api/commands lives in routes/command.ts since the Phase 2 extraction.
const serverSource = readFileSync(new URL('../../src/routes/command.ts', import.meta.url), 'utf8');

test('commands API route uses policy-backed visibility', () => {
    assert.match(
        serverSource,
        /import \{ getVisibleCommands \} from '\.\.\/command-contract\/policy\.js';/,
        'routes/command.ts should import getVisibleCommands from command policy',
    );
    assert.match(
        serverSource,
        /const commands = getVisibleCommands\(iface\);/,
        '/api/commands should use policy-backed visible commands',
    );
    assert.doesNotMatch(
        serverSource,
        /COMMANDS\s*\.\s*filter\([^)]*interfaces\.includes\(iface\)/s,
        '/api/commands must not directly filter COMMANDS by interface',
    );
});

test('commands API payload exposes workflow and capability metadata', () => {
    assert.match(serverSource, /workflow: c\.workflow \|\| null/, 'response should include workflow metadata');
    assert.match(serverSource, /capability: capability\?\.\[iface\] \|\| null/, 'response should include interface capability');
});

test('commands API route no longer imports COMMANDS directly', () => {
    assert.doesNotMatch(
        serverSource,
        /import \{[^}]*COMMANDS[^}]*\} from '\.\.\/cli\/commands\.js';/,
        'routes/command.ts should not import COMMANDS for /api/commands',
    );
});
