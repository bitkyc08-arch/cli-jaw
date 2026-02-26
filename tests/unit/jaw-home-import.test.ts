// Multi-Instance Phase 2.0: import centralization 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

// Files that MUST import JAW_HOME from config.ts (centralized)
const FILES_MUST_IMPORT = [
    'bin/commands/doctor.ts',
    'bin/commands/init.ts',
    'bin/commands/mcp.ts',
    'bin/commands/browser.ts',
    'bin/commands/skill.ts',
    'bin/commands/launchd.ts',
];

// Files that intentionally define JAW_HOME inline for install independence
// (postinstall.ts, mcp-sync.ts — no config.ts import to avoid registry.ts chain)
const FILES_INLINE_JAW_HOME = [
    'lib/mcp-sync.ts',
    'bin/postinstall.ts',
];

test('P20-001: all 6 command files import JAW_HOME from config', () => {
    for (const file of FILES_MUST_IMPORT) {
        const src = readFileSync(join(root, file), 'utf8');
        assert.ok(
            src.includes("from '../../src/core/config") ||
            src.includes("from '../src/core/config"),
            `${file} must import from config.ts`
        );
    }
});

test('P20-002: inline JAW_HOME files do NOT import config.ts', () => {
    for (const file of FILES_INLINE_JAW_HOME) {
        const src = readFileSync(join(root, file), 'utf8');
        assert.ok(
            !src.includes("from '../src/core/config") &&
            !src.includes("from '../../src/core/config"),
            `${file} must NOT import config.ts (install independence)`
        );
    }
});
