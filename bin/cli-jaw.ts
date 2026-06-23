#!/usr/bin/env node
/**
 * cli-jaw — Phase 9.1
 * CLI entrypoint with subcommand routing.
 * No external dependencies — Node built-in only.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { maybePromptGithubStar } from './star-prompt.js';
import { resolveHomePath } from '../src/core/path-expand.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
interface PackageJson {
    version?: string;
}

function readPackageJson(pkgPath: string): PackageJson {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as PackageJson : {};
}

let pkg: PackageJson;
let packageRoot = join(__dirname, '..');
try {
    const pkgPath = join(packageRoot, 'package.json');
    pkg = readPackageJson(pkgPath);
} catch {
    packageRoot = join(__dirname, '..', '..');
    const pkgPath = join(packageRoot, 'package.json');
    pkg = readPackageJson(pkgPath);
}

// ─── --home flag: must run BEFORE command parsing (ESM hoisting safe) ───
// Manual parsing instead of parseArgs to avoid absorbing subcommand flags
const _homeIdx = process.argv.indexOf('--home');
const _homeEqArg = process.argv.find(a => a.startsWith('--home='));
if (_homeIdx !== -1 && process.argv[_homeIdx + 1]) {
    const _homeVal = process.argv[_homeIdx + 1]!;
    // Guard: if the "value" looks like a known subcommand, user forgot the path
    const _knownCmds = ['serve', 'init', 'doctor', 'chat', 'employee', 'reset', 'mcp', 'skill', 'status', 'browser', 'memory', 'launchd', 'clone', 'service', 'dashboard', 'connector', 'reminders', 'orchestrate', 'dispatch', 'worker', 'project', 'goal', 'task', 'bgtask', 'jwc'];
    if (_knownCmds.includes(_homeVal)) {
        console.error(`  ❌ --home requires a path argument (got subcommand '${_homeVal}')`);
        console.error(`  Usage: jaw --home <path> ${_homeVal}`);
        process.exit(1);
    }
    process.env["CLI_JAW_HOME"] = resolveHomePath(_homeVal, homedir());
    process.argv.splice(_homeIdx, 2);
} else if (_homeIdx !== -1 && !process.argv[_homeIdx + 1]) {
    console.error('  ❌ --home requires a path argument');
    console.error('  Usage: jaw --home <path> <command>');
    process.exit(1);
} else if (_homeEqArg) {
    const val = _homeEqArg.slice('--home='.length);
    process.env["CLI_JAW_HOME"] = resolveHomePath(val, homedir());
    process.argv.splice(process.argv.indexOf(_homeEqArg), 1);
}

// ─── --NNNN port shorthand: sets CLI_JAW_HOME (~/.cli-jaw[-port]) + PORT ───
// e.g. `jaw serve --3458` → --home ~/.cli-jaw-3458 --port 3458.
// Must run AFTER --home parsing so an explicit --home wins for the home path.
const _portShortIdx = process.argv.findIndex(a => /^--\d{2,5}$/.test(a));
if (_portShortIdx !== -1) {
    const portStr = process.argv[_portShortIdx]!.slice(2);
    const portNum = Number(portStr);
    if (portNum < 1 || portNum > 65535) {
        console.error(`  ❌ Invalid port: ${portStr} (must be 1–65535)`);
        process.exit(1);
    }
    // Only auto-derive home when --home was not explicitly provided.
    if (!process.env["CLI_JAW_HOME"]) {
        process.env["CLI_JAW_HOME"] = portNum === 3457
            ? join(homedir(), '.cli-jaw')
            : join(homedir(), `.cli-jaw-${portNum}`);
    }
    process.env["PORT"] = portStr;
    process.argv.splice(_portShortIdx, 1);
}

const command = process.argv[2];

function shouldSkipNativeGuard(cmd: string | undefined): boolean {
    return !cmd || cmd === '--help' || cmd === '-h' || cmd === '--version' || cmd === '-v';
}

function ensureNativeModulesReady(cmd: string | undefined): void {
    if (shouldSkipNativeGuard(cmd)) return;
    const guardPath = join(packageRoot, 'scripts', 'ensure-native-modules.cjs');
    if (!existsSync(guardPath)) return;
    try {
        execFileSync(process.execPath, [guardPath], {
            cwd: packageRoot,
            stdio: 'inherit',
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[jaw:native] native dependency check failed for Node ${process.version}.`);
        console.error(`[jaw:native] ${message}`);
        process.exit(1);
    }
}

async function maybePromptForStarOnLaunch(): Promise<void> {
    try {
        await maybePromptGithubStar();
    } catch (err) {
        console.error(`[jaw] Star prompt skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function printHelp() {
    const c = { cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };
    console.log(`
${c.cyan}  🦈 jaw${c.reset} — AI agent orchestration platform  ${c.dim}v${pkg.version}${c.reset}

  ${c.bold}Usage:${c.reset}  jaw <command> [args] [--flags]
          jaw --home <path> <command>

  ${c.bold}Quick start:${c.reset}
    jaw init                            Initial setup wizard
    jaw serve                           Start server (foreground)
    jaw status --json                   Check server health
    jaw dashboard serve                 Multi-instance dashboard
    jaw doctor --json                   Diagnose installation

  ${c.bold}Agent decision guide:${c.reset}
    1. Check state first: jaw status [--json] or jaw dashboard status --json
    2. Use --json on any command for machine-readable output.
    3. Lifecycle actions need dashboard running: jaw dashboard start/stop <port>
    4. Dispatch employees: jaw dispatch --agent "Name" --task "..."
    5. Search memory: jaw memory search "<query>"

  ${c.bold}Server:${c.reset}
    serve [--port] [--no-open]          Start server (foreground)
    status [--json] [--dashboard]       Server health check
    dashboard <sub> [--json]            Multi-instance manager (jaw dashboard --help)

  ${c.bold}Setup & diagnostics:${c.reset}
    init                                Interactive setup wizard
    doctor [--json]                     Installation diagnostics
    jwc install|clean|doctor            Optional external JWC runtime helper
    reset [--all|--mcp|--skills|...]    Reset configuration

  ${c.bold}Orchestration:${c.reset}
    chat                                Terminal REPL
    dispatch --agent "N" --task "..."   Dispatch employee (pipe-compatible)
    worker status|watch [agent]         Inspect employee progress
    employee [list|reset]               Employee management
    orchestrate [P|A|B|C|D|reset]       PABCD state machine
    goal <set|status|done|cancel|...>   Persistent goal lifecycle
    task <add|done|list|assign|...>     Atomic task checklist
    bgtask <add|list|show|cancel>       Server-owned background tasks

  ${c.bold}Automation:${c.reset}
    browser <sub>                       Chrome CDP browser control
    memory <search|read|save>           Persistent memory store
    mcp <install|sync|list>             MCP server management
    skill <install|remove|info|list>    Skill management

  ${c.bold}Service management:${c.reset}
    service <install|status|unset|logs> Cross-platform auto-start (systemd/launchd)
    clone <port> [--home]               Clone instance as independent agent

  ${c.bold}Options:${c.reset}
    --home <path>       Data directory (default: ~/.cli-jaw)
    --<port>            Port shorthand (e.g. --3458 → --home ~/.cli-jaw-3458 --port 3458)
    --help, -h          Show help (works on all subcommands)
    --version, -v       Show version

  ${c.bold}Environment:${c.reset}
    CLI_JAW_HOME        Override data directory
    PORT                Default server port (3457)
    DASHBOARD_PORT      Dashboard port (24576)
	`);
}

ensureNativeModulesReady(command);

switch (command) {
    case 'serve':
        await maybePromptForStarOnLaunch();
        await import('./commands/serve.js');
        break;
    case 'init':
        await import('./commands/init.js');
        break;
    case 'doctor':
        await import('./commands/doctor.js');
        break;
    case 'jwc':
        await import('./commands/jwc.js');
        break;
    case 'chat':
        if (process.argv[3] === 'search') {
            await import('./commands/chat-search.js');
        } else {
            await maybePromptForStarOnLaunch();
            await import('./commands/chat.js');
        }
        break;
    case 'employee':
        await import('./commands/employee.js');
        break;
    case 'reset':
        await import('./commands/reset.js');
        break;
    case 'mcp':
        await import('./commands/mcp.js');
        break;
    case 'skill':
        await import('./commands/skill.js');
        break;
    case 'status':
        await import('./commands/status.js');
        break;
    case 'browser':
        await import('./commands/browser.js');
        break;
    case 'memory':
        await import('./commands/memory.js');
        break;
    case 'launchd':
        await import('./commands/launchd.js');
        break;
    case 'clone':
        await import('./commands/clone.js');
        break;
    case 'orchestrate':
        await import('./commands/orchestrate.js');
        break;
    case 'dispatch':
        await import('./commands/dispatch.js');
        break;
    case 'worker':
        await import('./commands/worker.js');
        break;
    case 'service':
        await import('./commands/service.js');
        break;
    case 'dashboard':
        await import('./commands/dashboard.js');
        break;
    case 'connector':
        await import('./commands/connector.js');
        break;
    case 'reminders':
        await import('./commands/reminders.js');
        break;
    case 'project':
        await import('./commands/project.js');
        break;
    case 'goal':
        await import('./commands/goal.js');
        break;
    case 'task':
        await import('./commands/task.js');
        break;
    case 'bgtask':
        await import('./commands/bgtask.js');
        break;
    case 'lock':
    case 'unlock':
        await import('./commands/lock.js');
        break;
    case 'history':
        await import('./commands/history.js');
        break;
    case '--version':
    case '-v':
        console.log(`cli-jaw v${pkg.version}`);
        break;
    case '--help':
    case '-h':
    case undefined:
        printHelp();
        break;
    default:
        console.error(`  ❌ Unknown command: ${command}\n`);
        printHelp();
        process.exitCode = 1;
        break;
}
