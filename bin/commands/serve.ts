/**
 * cli-jaw serve — Phase 9.1
 * Starts the server in foreground with signal forwarding.
 */
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getServerUrl } from '../../src/core/config.js';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
        port: { type: 'string', default: process.env.PORT || '3457' },
        host: { type: 'string', default: '0.0.0.0' },
        open: { type: 'boolean', default: true },
    },
    strict: false,
});

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
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));

child.on('exit', (code: number | null, signal: string | null) => {
    if (signal) {
        process.exit(1);
    }
    process.exit(code ?? 1);
});

child.on('error', (err: Error) => {
    console.error(`  ❌ Failed to start server: ${err.message}`);
    process.exit(1);
});
