import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { constants as osConstants } from 'node:os';
import { DASHBOARD_DEFAULT_PORT, MANAGED_INSTANCE_PORT_COUNT, MANAGED_INSTANCE_PORT_FROM } from '../../src/manager/constants.js';
import { shouldOpenBrowserByDefault } from '../../src/core/browser-open-default.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';
import { asArray, asRecord, fieldString, type JsonRecord } from '../_http-client.js';
import { resolveBundledNodePath } from '../../src/core/runtime-path.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandRoot = join(__dirname, '..', '..');
const projectRoot = existsSync(join(commandRoot, 'package.json'))
    ? commandRoot
    : join(commandRoot, '..');

const subcommand = process.argv[3] || 'serve';

if (shouldShowHelp(process.argv, 3)) printAndExit(`
  jaw dashboard — multi-instance manager

  Usage: jaw dashboard <command> [options] [--json]

  Commands:
    serve [--port] [--from] [--count] [--no-open]   Start dashboard server (foreground)
    status                  Dashboard health check
    ls                      List all instances
    start <port> [--home]   Start instance
    stop <port>             Stop instance
    restart <port>          Restart instance
    perm <port> [--home]    Register as persistent service
    unperm <port>           Unregister persistent service
    service [install|status|unset]  Dashboard auto-start management
    memory <search|read|instances>  L2 cross-instance memory federation (read-only)
    chat search "<query>"           L2 cross-instance chat search (read-only)

  Global options:
    --json                  Machine-readable JSON output
    --port <port>           Dashboard port (default: ${DASHBOARD_DEFAULT_PORT})

  Examples:
    jaw dashboard serve
    jaw dashboard status --json
    jaw dashboard ls --json | jq '.[] | select(.status == "online")'
    jaw dashboard start 3458 --home ~/.jaw-work
    jaw dashboard stop 3457
    jaw dashboard perm 3458 --home ~/.jaw-work
    jaw dashboard service install
    jaw dashboard service status
`);

const { values: globalOpts, positionals } = parseArgs({
    args: process.argv.slice(4),
    options: {
        json: { type: 'boolean', default: false },
        port: { type: 'string', default: process.env["DASHBOARD_PORT"] || DASHBOARD_DEFAULT_PORT },
        from: { type: 'string', default: String(MANAGED_INSTANCE_PORT_FROM) },
        count: { type: 'string', default: String(MANAGED_INSTANCE_PORT_COUNT) },
        open: { type: 'boolean', default: shouldOpenBrowserByDefault() },
        home: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
    allowNegative: true,
});

const json = globalOpts.json as boolean;
const dashboardPort = Number(globalOpts.port) || Number(DASHBOARD_DEFAULT_PORT);
const scanFrom = Number(globalOpts.from) || MANAGED_INSTANCE_PORT_FROM;
const scanCount = Number(globalOpts.count) || MANAGED_INSTANCE_PORT_COUNT;

switch (subcommand) {
    case 'serve':
        await handleServe();
        break;
    case 'status':
        await handleStatus();
        break;
    case 'ls':
    case 'list':
        await handleList();
        break;
    case 'start':
    case 'stop':
    case 'restart':
    case 'perm':
    case 'unperm':
        await handleLifecycle(subcommand);
        break;
    case 'service':
        await handleService();
        break;
    case 'memory': {
        const { handleMemory } = await import('./dashboard-memory.js');
        await handleMemory(process.argv.slice(4));
        break;
    }
    case 'chat': {
        const { handleDashboardChat } = await import('./dashboard-chat.js');
        await handleDashboardChat(process.argv.slice(4));
        break;
    }
    default:
        console.error(`  ❌ Unknown dashboard command: ${subcommand}`);
        console.error('  Run jaw dashboard --help for usage.');
        process.exit(1);
}

async function handleServe(): Promise<void> {
    const serverJs = join(projectRoot, 'dist', 'src', 'manager', 'server.js');
    const serverTs = join(projectRoot, 'src', 'manager', 'server.ts');
    const isDistMode = existsSync(serverJs);
    const command = isDistMode
        ? (resolveBundledNodePath(serverJs) ?? process.execPath)
        : (existsSync(join(projectRoot, 'node_modules', '.bin', 'tsx'))
            ? join(projectRoot, 'node_modules', '.bin', 'tsx')
            : 'tsx');
    const args = isDistMode ? [serverJs] : [serverTs];

    console.log(`\n  Jaw dashboard serve — port ${dashboardPort}`);
    console.log(`  Scanning ports ${scanFrom}-${scanFrom + scanCount - 1}\n`);

    const child = spawn(command, args, {
        stdio: 'inherit',
        env: {
            ...process.env,
            CLI_JAW_BIN: process.env["CLI_JAW_BIN"] || process.argv[1] || '',
            DASHBOARD_PORT: String(dashboardPort),
            DASHBOARD_SCAN_FROM: String(scanFrom),
            DASHBOARD_SCAN_COUNT: String(scanCount),
            ...(globalOpts.open ? { JAW_DASHBOARD_OPEN: '1' } : {}),
        },
    });

    let exiting = false;

    process.on('SIGINT', () => {
        if (exiting) return;
        exiting = true;
        child.kill('SIGINT');
    });

    process.on('SIGTERM', () => {
        if (exiting) return;
        exiting = true;
        child.kill('SIGTERM');
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (signal) {
            const sigCode = osConstants.signals[signal] ?? 9;
            process.exit(128 + sigCode);
        }
        process.exit(code ?? 1);
    });

    child.on('error', (error: Error) => {
        console.error(`Failed to start dashboard: ${error.message}`);
        process.exit(1);
    });
}

async function handleStatus(): Promise<void> {
    const url = `http://127.0.0.1:${dashboardPort}/api/dashboard/health`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        const data = await res.json() as JsonRecord;
        if (json) {
            console.log(JSON.stringify(data));
        } else {
            console.log(`  🦈 Dashboard running — port ${data["port"]}, pid ${data["pid"]}`);
            console.log(`  Scan range: ${data["rangeFrom"]}-${data["rangeTo"]}`);
        }
    } catch {
        const msg = { ok: false, error: `dashboard not running on port ${dashboardPort}` };
        if (json) console.log(JSON.stringify(msg));
        else console.error(`  ❌ Dashboard not running (port ${dashboardPort})`);
        process.exitCode = 1;
    }
}

async function handleList(): Promise<void> {
    const url = `http://127.0.0.1:${dashboardPort}/api/dashboard/instances?showHidden=true`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const data = await res.json() as JsonRecord;
        const instances = asArray<JsonRecord>(data["instances"]);
        if (json) {
            console.log(JSON.stringify(instances));
        } else {
            if (instances.length === 0) {
                console.log('  No instances found.');
                return;
            }
            console.log('');
            const pad = (s: string, n: number) => s.padEnd(n);
            console.log(`  ${pad('PORT', 6)} ${pad('STATUS', 10)} ${pad('OWNER', 10)} ${pad('CLI', 12)} ${pad('MODEL', 16)} LABEL`);
            console.log(`  ${'-'.repeat(70)}`);
            for (const inst of instances) {
                const lifecycle = asRecord(inst["lifecycle"]);
                const profile = asRecord(inst["profile"]);
                const port = String(inst["port"]);
                const status = fieldString(inst["status"], 'unknown');
                const owner = fieldString(lifecycle["owner"], 'n/a');
                const cli = fieldString(inst["currentCli"], 'n/a');
                const model = fieldString(inst["currentModel"], 'n/a');
                const label = fieldString(inst["label"]) || fieldString(profile["label"]) || `:${inst["port"]}`;
                console.log(`  ${pad(port, 6)} ${pad(status, 10)} ${pad(owner, 10)} ${pad(cli, 12)} ${pad(model, 16)} ${label}`);
            }
            console.log('');
        }
    } catch {
        const msg = { ok: false, error: `dashboard not running on port ${dashboardPort}` };
        if (json) console.log(JSON.stringify(msg));
        else console.error(`  ❌ Dashboard not running (port ${dashboardPort})`);
        process.exitCode = 1;
    }
}

async function handleLifecycle(action: string): Promise<void> {
    const targetPort = Number(positionals[0]);
    if (!targetPort || targetPort < 1) {
        console.error(`  Usage: jaw dashboard ${action} <port> [--home <path>]`);
        process.exit(1);
    }
    const url = `http://127.0.0.1:${dashboardPort}/api/dashboard/lifecycle/${action}`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port: targetPort, home: globalOpts.home }),
            signal: AbortSignal.timeout(15000),
        });
        const result = await res.json() as JsonRecord;
        if (json) {
            console.log(JSON.stringify(result));
            if (!result["ok"]) process.exitCode = 1;
            return;
        }
        const icon = result["ok"] ? '✅' : '❌';
        console.log(`${icon} ${result["action"]} :${result["port"]} — ${result["message"]}`);
        if (result["pid"]) console.log(`   PID: ${result["pid"]}`);
        if (!result["ok"]) process.exitCode = 1;
    } catch {
        const msg = { ok: false, error: `dashboard not running on port ${dashboardPort}` };
        if (json) console.log(JSON.stringify(msg));
        else console.error(`  ❌ Dashboard not running (port ${dashboardPort})`);
        process.exitCode = 1;
    }
}

async function handleService(): Promise<void> {
    const serviceSub = positionals[0] || 'install';
    const { permDashboard, unpermDashboard, dashboardServiceStatus } = await import(
        '../../src/manager/dashboard-service.js'
    );
    switch (serviceSub) {
        case 'install':
            await permDashboard(dashboardPort, scanFrom, scanCount);
            break;
        case 'status':
            await dashboardServiceStatus(json);
            break;
        case 'unset':
            await unpermDashboard(json);
            break;
        default:
            console.error(`  Unknown service command: ${serviceSub}`);
            console.error('  Usage: jaw dashboard service [install|status|unset]');
            process.exit(1);
    }
}
