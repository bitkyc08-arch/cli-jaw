/**
 * cli-jaw serve — Phase 9.1
 * Starts the server in foreground with signal forwarding.
 */
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { settings, loadSettings } from '../../src/core/config.js';
import { shouldOpenBrowserByDefault } from '../../src/core/browser-open-default.js';
import fs from 'node:fs';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';
import { resolveBundledNodePath } from '../../src/core/runtime-path.js';

loadSettings();

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw serve — start jaw server (foreground)

  Usage: jaw serve [--port <3457>] [--no-open] [--home <path>]

  Options:
    --port <N>    Server port (default: 3457, or PORT env)
    --no-open     Don't open browser on start

  The server must be running for chat, dispatch, and browser commands.
  Use 'jaw service install' to run as a background daemon instead.
`);

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

const { values } = parseArgs({
    args: process.argv.slice(3),
    allowNegative: true,
    options: {
        port: { type: 'string', default: process.env["PORT"] || settings["port"] || '3457' },
        host: { type: 'string', default: '0.0.0.0' },
        open: { type: 'boolean', default: shouldOpenBrowserByDefault() },
        lan: { type: 'boolean', default: false },
        remote: { type: 'boolean', default: false },
        'trust-proxy': { type: 'boolean', default: false },
        'trust-forwarded': { type: 'boolean', default: false },
    },
    strict: false,
});

// Detect source vs dist: if server.js exists, use node; else use tsx + server.ts
const serverJs = join(projectRoot, 'server.js');
const serverTs = join(projectRoot, 'server.ts');
const isDistMode = fs.existsSync(serverJs);
const serverPath = isDistMode ? serverJs : serverTs;
const envFile = join(projectRoot, '.env');

const modeLabels = [
    values.lan ? 'LAN mode' : '',
    values.remote ? 'Remote mode' : '',
    values['trust-proxy'] ? 'trust proxy' : '',
    values['trust-forwarded'] ? 'trust forwarded' : '',
].filter(Boolean);
console.log(`\n  🦈 cli-jaw serve — port ${values.port}${modeLabels.length ? ` (${modeLabels.join(', ')})` : ''}\n`);

let child;
if (isDistMode) {
    // dist mode: prefer the sidecar Node next to dist/ when present.
    const nodeArgs = ['--dns-result-order=ipv4first'];
    if (fs.existsSync(envFile)) nodeArgs.unshift(`--env-file=${envFile}`);
    const nodePath = resolveBundledNodePath(serverPath) ?? process.execPath;
    child = spawn(nodePath,
        [...nodeArgs, serverPath],
        {
            stdio: 'inherit',
            env: { ...process.env, PORT: values.port as string, HOST: values.host as string, ...(values.open ? { JAW_OPEN_BROWSER: '1' } : {}), ...(values.lan ? { JAW_LAN_MODE: '1' } : {}), ...(values.remote ? { JAW_REMOTE_ACCESS_MODE: 'direct' } : {}), ...(values['trust-proxy'] ? { JAW_TRUST_PROXY: '1' } : {}), ...(values['trust-forwarded'] ? { JAW_TRUST_FORWARDED: '1' } : {}) },
        }
    );
} else {
    // source mode: spawn tsx
    const localTsx = join(projectRoot, 'node_modules', '.bin', 'tsx');
    const tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx';
    const tsxArgs: string[] = [];
    if (fs.existsSync(envFile)) tsxArgs.push(`--env-file=${envFile}`);
    tsxArgs.push(serverPath);
    child = spawn(tsxBin,
        tsxArgs,
        {
            stdio: 'inherit',
            env: { ...process.env, PORT: values.port as string, HOST: values.host as string, ...(values.open ? { JAW_OPEN_BROWSER: '1' } : {}), ...(values.lan ? { JAW_LAN_MODE: '1' } : {}), ...(values.remote ? { JAW_REMOTE_ACCESS_MODE: 'direct' } : {}), ...(values['trust-proxy'] ? { JAW_TRUST_PROXY: '1' } : {}), ...(values['trust-forwarded'] ? { JAW_TRUST_FORWARDED: '1' } : {}) },
        }
    );
}

// Forward signals

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

import os from 'node:os';

child.on('exit', (code: number | null, signal: string | null) => {
    if (signal) {
        const sigNames: Record<string, number> = os.constants?.signals || {};
        const sigCode = sigNames[signal] ?? 9;
        process.exit(128 + sigCode);
    }
    process.exit(code ?? 1);
});

child.on('error', (err: Error) => {
    console.error(`  ❌ Failed to start server: ${err.message}`);
    process.exit(1);
});
