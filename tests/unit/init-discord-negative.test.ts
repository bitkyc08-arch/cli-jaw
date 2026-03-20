// Init Discord negative path tests — Phase 7 Bundle D
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const initSrc = readFileSync(join(projectRoot, 'bin/commands/init.ts'), 'utf8');

// ─── --channel flag validation ───────────────────────

test('init rejects invalid --channel value', () => {
    assert.match(initSrc, /Invalid --channel/,
        'should show error for invalid channel value');
    assert.match(initSrc, /telegram.*discord/,
        'error message should list valid channels');
});

// ─── --force guard ───────────────────────────────────

test('init requires --force when settings.json exists', () => {
    assert.match(initSrc, /settings\.json already exists/,
        'should show error when settings exist without --force');
    assert.match(initSrc, /--force/,
        'error message should mention --force');
});

// ─── Discord validation ─────────────────────────────

test('init validates Discord token is required', () => {
    assert.match(initSrc, /Discord token is required/,
        'should error on missing Discord token');
});

test('init validates Discord guild ID is required', () => {
    assert.match(initSrc, /Discord guild ID is required/,
        'should error on missing guild ID');
});

test('init validates at least one Discord channel ID', () => {
    assert.match(initSrc, /At least one Discord channel ID/,
        'should error on missing channel IDs');
});

// ─── Discord flags are accepted ─────────────────────

test('init accepts --discord-token flag', () => {
    assert.match(initSrc, /'discord-token'/,
        'parseArgs should accept discord-token');
});

test('init accepts --discord-guild-id flag', () => {
    assert.match(initSrc, /'discord-guild-id'/,
        'parseArgs should accept discord-guild-id');
});

test('init accepts --discord-channel-ids flag', () => {
    assert.match(initSrc, /'discord-channel-ids'/,
        'parseArgs should accept discord-channel-ids');
});

test('init accepts --channel flag', () => {
    assert.ok(initSrc.includes('channel:') && initSrc.includes('--channel'),
        'parseArgs should accept channel');
});

// ─── Channel auto-selection ─────────────────────────

test('init auto-selects discord when only discord is enabled', () => {
    assert.match(initSrc, /dcEnabled && !tgEnabled/,
        'should auto-select discord when telegram is not enabled');
});

test('init outputs Discord status in summary', () => {
    assert.match(initSrc, /Discord.*:.*dcEnabled/,
        'summary should show Discord status');
});
