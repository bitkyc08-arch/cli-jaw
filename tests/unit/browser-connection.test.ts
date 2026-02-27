import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');

const connectionSrc = fs.readFileSync(join(root, 'src', 'browser', 'connection.ts'), 'utf8');
const routesSrc = fs.readFileSync(join(root, 'src', 'routes', 'browser.ts'), 'utf8');
const cliBrowserSrc = fs.readFileSync(join(root, 'bin', 'commands', 'browser.ts'), 'utf8');

// ─── DIFF-A: connection.ts ───────────────────────────

test('CDP-001: launchChrome has readiness polling (waitForCdpReady)', () => {
    assert.match(
        connectionSrc,
        /waitForCdpReady/,
        'connection.ts should call waitForCdpReady for CDP readiness polling instead of blind sleep',
    );
});

test('CDP-002: launchChrome supports headless flag', () => {
    assert.match(
        connectionSrc,
        /--headless=new/,
        'connection.ts should pass --headless=new flag to Chrome when headless is enabled',
    );
});

test('CDP-003: connectCdp has retry logic', () => {
    assert.match(
        connectionSrc,
        /retries/,
        'connection.ts connectCdp should have a retries parameter',
    );
    assert.match(
        connectionSrc,
        /for\s*\(\s*let\s+i\s*=\s*0/,
        'connection.ts connectCdp should have a retry for-loop',
    );
});

test('CDP-004: launchChrome checks port before spawn', () => {
    assert.match(
        connectionSrc,
        /isPortListening/,
        'connection.ts should call isPortListening before spawning Chrome to detect reusable CDP',
    );
});

test('CDP-005: CHROME_HEADLESS env var recognized', () => {
    assert.match(
        connectionSrc,
        /CHROME_HEADLESS/,
        'connection.ts should recognize CHROME_HEADLESS environment variable for headless mode',
    );
});

// ─── DIFF-B: routes/browser.ts ───────────────────────

test('CDP-006: API /start passes headless option', () => {
    assert.match(
        routesSrc,
        /req\.body\?\.headless/,
        'routes/browser.ts should extract headless from request body and pass to launchChrome',
    );
});

// ─── DIFF-C: bin/commands/browser.ts ─────────────────

test('CDP-007: CLI --headless option exists', () => {
    assert.match(
        cliBrowserSrc,
        /headless:\s*\{\s*type:\s*'boolean'/,
        'bin/commands/browser.ts should have --headless as a parseArgs boolean option',
    );
});

// ─── DIFF-D: skills_ref/browser/SKILL.md ────────────

test('CDP-008: skills_ref SKILL.md uses cli-jaw not cli-claw', { skip: !fs.existsSync(join(root, 'skills_ref', 'browser', 'SKILL.md')) && 'skills_ref submodule not checked out' }, () => {
    const skillPath = join(root, 'skills_ref', 'browser', 'SKILL.md');
    const skillSrc = fs.readFileSync(skillPath, 'utf8');
    assert.doesNotMatch(
        skillSrc,
        /cli-claw/,
        'skills_ref/browser/SKILL.md should not contain cli-claw (old name)',
    );
});

// ─── Additional regression guards ───────────────────

test('CDP-009: connection.ts has net import for isPortListening', () => {
    assert.match(
        connectionSrc,
        /import\s+net\s+from\s+['"]node:net['"]/,
        'connection.ts should import net from node:net for port checking',
    );
});

test('CDP-010: launchChrome signature is backward compatible', () => {
    // Ensure the opts parameter has a default value
    assert.match(
        connectionSrc,
        /launchChrome\(port\s*=\s*deriveCdpPort\(\),\s*opts.*=\s*\{\}/,
        'launchChrome should have opts with default empty object for backward compatibility',
    );
});

test('CDP-011: connectCdp uses timeout in connectOverCDP', () => {
    assert.match(
        connectionSrc,
        /connectOverCDP\(cdpUrl,\s*\{\s*timeout:/,
        'connectCdp should pass explicit timeout to connectOverCDP',
    );
});

test('CDP-012: blind 2s sleep removed', () => {
    assert.doesNotMatch(
        connectionSrc,
        /setTimeout\(r\s*=>\s*r\(\),\s*2000\)/,
        'connection.ts should not have the old blind 2000ms sleep in launchChrome',
    );
});
