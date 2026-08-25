/**
 * cli-jaw status — Phase 9.1
 * Checks if the server is running by pinging the API.
 */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getServerUrl, DEFAULT_PORT } from '../../src/core/config.js';
import { JAW_HOME } from '../../src/core/config.js';
import { DASHBOARD_DEFAULT_PORT } from '../../src/manager/constants.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';
import { asArray, asRecord } from '../_http-client.js';

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw status — check server health

  Usage: jaw status [--port <3457>] [--json] [--dashboard]

  Options:
    --port <N>      Target port (default: 3457)
    --json          Machine-readable output
    --dashboard     Also check dashboard server (port 24576)

  Exit codes:
    0  Server running
    1  Server not running or error
`);

const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
        // No default here on purpose: a default makes "--port was omitted"
        // indistinguishable from "--port 3457", and `jaw --home <path> status`
        // then probed 3457 no matter which instance the home belongs to (#436).
        port: { type: 'string' },
        json: { type: 'boolean', default: false },
        dashboard: { type: 'boolean', default: false },
    },
    strict: false,
});

/** Port for the home this invocation targets: explicit flag, then the running
 *  instance's pidfile, then its settings, then the built-in default. */
function resolvePort(): string {
    if (values.port) return String(values.port);
    if (process.env["PORT"]) return String(process.env["PORT"]);
    try {
        const pidfile = join(JAW_HOME, 'jaw.pid.json');
        if (existsSync(pidfile)) {
            const rec = JSON.parse(readFileSync(pidfile, 'utf8')) as { port?: unknown };
            if (Number.isFinite(Number(rec.port)) && Number(rec.port) > 0) return String(rec.port);
        }
    } catch { /* unreadable pidfile — fall through to settings */ }
    try {
        const settingsPath = join(JAW_HOME, 'settings.json');
        if (existsSync(settingsPath)) {
            const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as { port?: unknown };
            if (Number.isFinite(Number(s.port)) && Number(s.port) > 0) return String(s.port);
        }
    } catch { /* unreadable settings — fall through to default */ }
    return DEFAULT_PORT;
}

const resolvedPort = resolvePort();
const url = `${getServerUrl(resolvedPort)}/api/settings`;

try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        if (values.json) {
            console.log(JSON.stringify({ status: 'running', port: resolvedPort, cli: data["cli"] }));
        } else {
            console.log(`  🦈 Server is running on port ${resolvedPort}`);
            console.log(`  CLI: ${data["cli"]}`);
            console.log(`  Working dir: ${data["workingDir"] || '~'}`);

            // Heartbeat status
            try {
                const hbRes = await fetch(`${getServerUrl(resolvedPort)}/api/heartbeat`, { signal: AbortSignal.timeout(2000) });
                const hb = asRecord(await hbRes.json());
                const active = asArray<{ enabled?: boolean }>(hb["jobs"]).filter((j) => j.enabled).length;
                console.log(`  Heartbeat: ${active} job${active !== 1 ? 's' : ''} active`);
            } catch { } // best-effort: heartbeat probe optional when server is down
        }
    } else {
        console.log(`  ⚠️ Server responded with ${res.status}`);
        process.exitCode = 1;
    }
} catch {
    if (values.json) {
        console.log(JSON.stringify({ status: 'stopped' }));
    } else {
        console.log(`  ❌ Server not running (port ${resolvedPort})`);
    }
    process.exitCode = 1;
}

if (values.dashboard) {
    const dashPort = Number(process.env["DASHBOARD_PORT"] || DASHBOARD_DEFAULT_PORT);
    const dashUrl = `http://127.0.0.1:${dashPort}/api/dashboard/health`;
    try {
        const dashRes = await fetch(dashUrl, { signal: AbortSignal.timeout(3000) });
        const dashData = await dashRes.json() as Record<string, unknown>;
        if (values.json) {
            console.log(JSON.stringify({ dashboard: { status: 'running', ...dashData } }));
        } else {
            console.log(`  🖥️  Dashboard running — port ${dashData["port"]}, pid ${dashData["pid"]}`);
            console.log(`  Scan: ${dashData["rangeFrom"]}-${dashData["rangeTo"]}`);
        }
    } catch {
        if (values.json) console.log(JSON.stringify({ dashboard: { status: 'stopped' } }));
        else console.log(`  ❌ Dashboard not running (port ${dashPort})`);
    }
}
