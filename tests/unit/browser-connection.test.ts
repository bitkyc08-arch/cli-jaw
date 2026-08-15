import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readSource } from './source-normalize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');

const connectionSrc = readSource(join(root, 'src', 'browser', 'connection.ts'), 'utf8');
const diagnosticsSrc = readSource(join(root, 'src', 'browser', 'runtime-diagnostics.ts'), 'utf8');
const orphanSrc = readSource(join(root, 'src', 'browser', 'runtime-orphans.ts'), 'utf8');
const ownerStoreSrc = readSource(join(root, 'src', 'browser', 'runtime-owner-store.ts'), 'utf8');
const routesSrc = readSource(join(root, 'src', 'routes', 'browser.ts'), 'utf8');
const cliBrowserSrc = readSource(join(root, 'bin', 'commands', 'browser.ts'), 'utf8');

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

test('CDP-005: connection.ts delegates headless policy to launch policy helper', () => {
    assert.match(
        connectionSrc,
        /resolveLaunchPolicy/,
        'connection.ts should delegate mode/headless behavior to launch policy helper',
    );
});

test('CDP-005b: connection.ts verifies jaw-owned Chrome on Windows instead of failing closed', () => {
    assert.match(
        connectionSrc,
        /powershell\.exe/,
        'Windows process command line lookup should use PowerShell when available',
    );
    assert.match(
        connectionSrc,
        /wmic\.exe/,
        'Windows process command line lookup should fall back to WMIC',
    );
    assert.doesNotMatch(
        connectionSrc,
        /if \(process\.platform === 'win32'\) return false/,
        'Windows ownership proof must not be hardcoded to false',
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

// ─── DIFF-D: skills_ref/jaw-browser/SKILL.md ────────────

test('CDP-008: skills_ref SKILL.md uses cli-jaw not cli-claw', { skip: !fs.existsSync(join(root, 'skills_ref', 'browser', 'SKILL.md')) && 'skills_ref submodule not checked out' }, () => {
    const skillPath = join(root, 'skills_ref', 'browser', 'SKILL.md');
    const skillSrc = readSource(skillPath, 'utf8');
    assert.doesNotMatch(
        skillSrc,
        /cli-claw/,
        'skills_ref/jaw-browser/SKILL.md should not contain cli-claw (old name)',
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
        /launchChrome\(\s*port\s*=\s*deriveCdpPort\(\),[\s\S]*opts[\s\S]*=\s*\{\}/,
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

test('CDP-013: runtime ownership is tracked separately from activePort', () => {
    assert.match(
        connectionSrc,
        /let\s+runtimeOwner:\s*BrowserRuntimeOwner\s*\|\s*null\s*=\s*null/,
        'connection.ts should track runtime ownership separately from activePort',
    );
    assert.match(
        connectionSrc,
        /createExternalBrowserRuntime\(port\)/,
        'reused CDP ports should be classified as external',
    );
    assert.match(
        connectionSrc,
        /createJawOwnedBrowserRuntime\(\{[\s\S]*pid:\s*chromeProc\.pid\s*\?\?\s*null[\s\S]*headless/,
        'spawned Chrome should be classified as current-process Jaw-owned',
    );
});

test('CDP-014: browser status includes runtime metadata without activity touch', () => {
    const statusFn = connectionSrc.match(/export async function getBrowserStatus[\s\S]*?\n}\n\nexport function getBrowserRuntimeStatus/)?.[0] || '';
    assert.match(statusFn, /runtime:\s*getBrowserRuntimeStatus\(\)/);
    assert.doesNotMatch(statusFn, /touchBrowserRuntime|beginBrowserActivity|withBrowserActivity/);
});

test('CDP-015: route-level activity covers browser work but excludes status/start/stop', () => {
    const activityList = routesSrc.match(/const BROWSER_ACTIVITY_PATHS = \[[\s\S]*?\];/)?.[0] || '';
    for (const path of [
        '/api/browser/snapshot',
        '/api/browser/tabs',
        '/api/browser/web-ai/status',
        '/api/browser/web-ai/send',
        '/api/browser/web-ai/diagnose',
    ]) {
        assert.match(activityList, new RegExp(path.replace(/[/-]/g, '\\$&')));
    }
    assert.doesNotMatch(activityList, /\/api\/browser\/status['"]/);
    assert.doesNotMatch(activityList, /\/api\/browser\/start['"]/);
    assert.doesNotMatch(activityList, /\/api\/browser\/stop['"]/);
});

test('CDP-016: CLI status prints runtime owner and idle close policy', () => {
    assert.match(cliBrowserSrc, /owner:\s*\$\{runtime\.ownership \|\| 'none'\}/);
    assert.match(cliBrowserSrc, /idleClose:/);
});

test('CDP-017: launchChrome clears stale jaw-owned process memory when CDP is gone', () => {
    assert.match(connectionSrc, /resetStaleChromeProcIfCdpUnavailable/);
    assert.match(connectionSrc, /waitForCdpReady\(port,\s*1000\)/);
    assert.match(connectionSrc, /chromeProc\.kill\('SIGTERM'\)/);
    assert.match(connectionSrc, /runtimeOwner\?\.ownership === 'jaw-owned'/);
    assert.match(connectionSrc, /runtimeOwner = null/);
    assert.match(connectionSrc, /activePort = null/);
    assert.match(connectionSrc, /verifiedActiveTargetId = null/);
    assert.match(connectionSrc, /const reset = await resetStaleChromeProcIfCdpUnavailable\(port\)/);
});

test('CDP-018: CLI start failure includes runtime diagnostics', () => {
    assert.match(cliBrowserSrc, /Failed to start Chrome/);
    assert.match(cliBrowserSrc, /owner:\s*\$\{runtime\.ownership \|\| 'none'\}/);
    assert.match(cliBrowserSrc, /tabs:\s*\$\{r\.tabs \?\? 0\}/);
    assert.match(cliBrowserSrc, /cli-jaw browser status/);
});

test('CDP-019: browser doctor reports stale runtime and orphan cleanup scope', () => {
    assert.match(diagnosticsSrc, /stale-jaw-owned-runtime/);
    assert.match(diagnosticsSrc, /durable-jaw-owned-runtime-records-only/);
    assert.match(diagnosticsSrc, /idleAutoCloseScope/);
    assert.match(diagnosticsSrc, /safeExternalKill:\s*false/);
    assert.match(routesSrc, /\/api\/browser\/doctor/);
    assert.match(cliBrowserSrc, /case 'doctor'/);
    assert.match(cliBrowserSrc, /orphanJanitor:/);
});

test('CDP-020: orphan runtime cleanup requires durable ownership proof and force', () => {
    assert.match(connectionSrc, /writeDurableBrowserRuntimeOwner\(owner\)/);
    assert.match(connectionSrc, /clearDurableBrowserRuntimeOwner\(owner\)/);
    assert.match(ownerStoreSrc, /browser-runtime-owner\.json/);
    assert.match(ownerStoreSrc, /Pick<BrowserRuntimeOwner,\s*'pid'\s*\|\s*'port'\s*\|\s*'userDataDir'>/);
    assert.match(orphanSrc, /commandLineMatchesDurableRuntimeOwner/);
    assert.match(orphanSrc, /commandLineHasExactFlagValue/);
    assert.match(orphanSrc, /clearDurableBrowserRuntimeOwner\(candidate\)/);
    assert.match(orphanSrc, /command\.includes\('--type='\)/);
    assert.match(orphanSrc, /remote-debugging-port/);
    assert.match(orphanSrc, /user-data-dir/);
    assert.match(routesSrc, /\/api\/browser\/cleanup-runtimes/);
    assert.match(routesSrc, /cleanup-runtimes close requires force=true/);
    assert.match(cliBrowserSrc, /case 'cleanup-runtimes'/);
    assert.match(cliBrowserSrc, /cleanup-runtimes --close requires --force/);
});
