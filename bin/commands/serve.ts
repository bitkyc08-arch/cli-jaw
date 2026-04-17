/**
 * cli-jaw serve — Phase 9.1
 * Starts the server in foreground with signal forwarding.
 */
import { spawn, execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getServerUrl } from '../../src/core/config.js';
import { JAW_HOME } from '../../src/core/config.js';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

const { values } = parseArgs({
    args: process.argv.slice(3),
    allowNegative: true,
    options: {
        port: { type: 'string', default: process.env.PORT || '3457' },
        host: { type: 'string', default: '0.0.0.0' },
        open: { type: 'boolean', default: true },
    },
    strict: false,
});

// ─── Auto-route through Jaw.app for TCC inheritance ──
if (
    process.platform === 'darwin'
    && !process.env.CLI_JAW_VIA_APP
    && fs.existsSync('/Applications/Jaw.app/Contents/MacOS/jaw-launcher')
) {
    const port = Number(values.port) || 3457;
    const { addInstance } = await import('../../src/core/jawapp-instances.js');
    addInstance(JAW_HOME, port);
    console.log(`\n  🦈 cli-jaw serve — Jaw.app 경유 (TCC 권한 상속)\n`);

    // Send SIGHUP if serve-manager is already running
    try {
        const pid = execFileSync('pgrep', ['-f', 'Jaw.app/Contents/MacOS/jaw-launcher'], {
            encoding: 'utf8', stdio: 'pipe',
        }).trim().split('\n')[0];
        if (pid) {
            execFileSync('kill', ['-HUP', pid], { stdio: 'pipe' });
            console.log(`  ✅ Jaw.app에 인스턴스 추가 알림 (SIGHUP → PID ${pid})`);
            console.log(`  http://localhost:${port}`);
            console.log(`  로그: ${join(JAW_HOME, 'logs')}/jaw-serve.log\n`);
            process.exit(0);
        }
    } catch { /* not running — start it */ }

    try {
        execFileSync('open', ['-a', 'Jaw'], { stdio: 'pipe' });
        console.log('  ✅ Jaw.app 시작됨');
        console.log(`  http://localhost:${port}`);
        console.log(`  로그: ${join(JAW_HOME, 'logs')}/jaw-serve.log\n`);
    } catch {
        console.warn('  ⚠️  Jaw.app 실행 실패 — 직접 serve로 전환');
    }
    process.exit(0);
}

// Detect source vs dist: if server.js exists, use node; else use tsx + server.ts
const serverJs = join(projectRoot, 'server.js');
const serverTs = join(projectRoot, 'server.ts');
const isDistMode = fs.existsSync(serverJs);
const serverPath = isDistMode ? serverJs : serverTs;
const envFile = join(projectRoot, '.env');

console.log(`\n  🦈 cli-jaw serve — port ${values.port}\n`);

let child;
if (isDistMode) {
    // dist mode: spawn node directly
    const nodeArgs = ['--dns-result-order=ipv4first'];
    if (fs.existsSync(envFile)) nodeArgs.unshift(`--env-file=${envFile}`);
    child = spawn(process.execPath,
        [...nodeArgs, serverPath],
        {
            stdio: 'inherit',
            env: { ...process.env, PORT: values.port as string, HOST: values.host as string, ...(values.open ? { JAW_OPEN_BROWSER: '1' } : {}) },
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
            env: { ...process.env, PORT: values.port as string, HOST: values.host as string, ...(values.open ? { JAW_OPEN_BROWSER: '1' } : {}) },
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
