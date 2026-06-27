#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'agy-quota');
const EMAIL_PLACEHOLDER = 'redacted@example.invalid';
const REDACTED = '[REDACTED]';
const REDACT_KEYS = new Set([
    'email',
    'account',
    'accountid',
    'user',
    'id',
    'requestid',
    'request_id',
    'token',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'apikey',
    'secret',
    'password',
    'bearer',
    'cookie',
    'authorization',
]);

function usage() {
    console.log(`Usage: node scripts/capture-agy-quota-fixture.mjs [--out <path>]

Capture antigravity-usage --json, redact account identifiers, and write an AGY
quota fixture. Review the output manually before committing.

Options:
  --out <path>  Write to a custom JSON path.
  -h, --help    Show this help.
`);
}

function parseArgs(argv) {
    const args = { out: '' };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') {
            usage();
            process.exit(0);
        }
        if (arg === '--out') {
            const value = argv[i + 1];
            if (!value) throw new Error('--out requires a path');
            args.out = value;
            i += 1;
            continue;
        }
        throw new Error(`unknown argument: ${arg}`);
    }
    return args;
}

function runJson() {
    const commands = [
        ['antigravity-usage', ['--json']],
        ['npx', ['--yes', 'antigravity-usage', '--json']],
    ];
    const errors = [];
    for (const [binary, args] of commands) {
        try {
            return execFileSync(binary, args, {
                encoding: 'utf8',
                timeout: 15000,
                maxBuffer: 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            errors.push(`${binary}: ${error.message}`);
        }
    }
    throw new Error(`failed to run antigravity-usage JSON capture:\n${errors.join('\n')}`);
}

function redactString(value, forceEmail = false) {
    if (forceEmail) return EMAIL_PLACEHOLDER;
    return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, EMAIL_PLACEHOLDER);
}

function redact(value, key = '') {
    if (Array.isArray(value)) return value.map(item => redact(item));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [rawKey, rawValue] of Object.entries(value)) {
            const normalized = rawKey.toLowerCase().replace(/[-_\s]/g, '');
            if (REDACT_KEYS.has(normalized)) {
                out[rawKey] = normalized === 'email'
                    ? EMAIL_PLACEHOLDER
                    : typeof rawValue === 'string'
                        ? redactString(rawValue) === rawValue ? REDACTED : EMAIL_PLACEHOLDER
                        : REDACTED;
                continue;
            }
            out[rawKey] = redact(rawValue, rawKey);
        }
        return out;
    }
    if (typeof value === 'string') {
        return redactString(value, key.toLowerCase() === 'email');
    }
    return value;
}

function defaultOutPath() {
    const day = new Date().toISOString().slice(0, 10);
    return path.join(FIXTURE_DIR, `live-redacted-${day}.json`);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const raw = runJson().trim();
    if (!raw.startsWith('{')) throw new Error('antigravity-usage output is not a JSON object');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('antigravity-usage output must be a JSON object');
    }
    const redacted = redact(parsed);
    const outPath = path.resolve(args.out || defaultOutPath());
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(redacted, null, 2)}\n`);
    console.log(outPath);
}

try {
    main();
} catch (error) {
    console.error((error instanceof Error ? error.message : String(error)));
    process.exit(1);
}
