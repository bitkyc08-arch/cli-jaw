/**
 * cli-claw serve — Phase 9.1
 * Starts the server in foreground with signal forwarding.
 */
import { spawn, exec } from 'node:child_process';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getServerUrl } from '../../src/config.js';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
        port: { type: 'string', default: process.env.PORT || '3457' },
        host: { type: 'string', default: '0.0.0.0' },
        open: { type: 'boolean', default: false },
    },
    strict: false,
});

const serverPath = join(projectRoot, 'server.js');
const envFile = join(projectRoot, '.env');

console.log(`\n  🦞 cli-claw serve — port ${values.port}\n`);

const nodeArgs = ['--dns-result-order=ipv4first'];
if (fs.existsSync(envFile)) nodeArgs.unshift(`--env-file=${envFile}`);

const child = spawn(process.execPath,
    [...nodeArgs, serverPath],
    {
        stdio: 'inherit',
        env: { ...process.env, PORT: values.port, HOST: values.host },
    }
);

// Forward signals
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));

child.on('exit', (code, signal) => {
    if (signal) {
        process.exit(1);
    }
    process.exit(code ?? 1);
});

child.on('error', (err) => {
    console.error(`  ❌ Failed to start server: ${err.message}`);
    process.exit(1);
});

// --open: open browser after a short delay
if (values.open) {
    setTimeout(() => {
        exec(`open ${getServerUrl(values.port)}`, (err) => {
            if (err) console.log('  ⚠️ Could not open browser');
        });
    }, 2000);
}
