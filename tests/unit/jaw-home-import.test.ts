// Multi-Instance Phase 2.0: import centralization 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

const FILES_MUST_IMPORT = [
    'bin/commands/doctor.ts',
    'bin/commands/init.ts',
    'bin/commands/mcp.ts',
    'bin/commands/browser.ts',
    'bin/commands/skill.ts',
    'bin/commands/launchd.ts',
    'lib/mcp-sync.ts',
    'bin/postinstall.ts',
];

test('P20-001: all 8 files import JAW_HOME from config', () => {
    for (const file of FILES_MUST_IMPORT) {
        const src = readFileSync(join(root, file), 'utf8');
        assert.ok(
            src.includes("from '../../src/core/config") ||
            src.includes("from '../src/core/config"),
            `${file} must import from config.ts`
        );
    }
});

test('P20-002: no file defines local JAW_HOME via homedir()', () => {
    for (const file of FILES_MUST_IMPORT) {
        const src = readFileSync(join(root, file), 'utf8');
        const hasLocalDef = /const\s+(?:jawHome|JAW_HOME)\s*=\s*(?:path\.)?join\(.*homedir/.test(src);
        assert.ok(!hasLocalDef, `${file} should not define local JAW_HOME via homedir()`);
    }
});
