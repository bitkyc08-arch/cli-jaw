/**
 * cli-jaw jwc - external-only JWC runtime helper.
 *
 * JWC is intentionally not bundled in cli-jaw npm installs or Electron
 * sidecars. This command installs/removes the optional jawcode runtime under a
 * CLI_JAW_HOME-owned prefix and prints the JWC_SDK_PATH users must opt into.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { JAW_HOME } from '../../src/core/config.js';
import { resolveHomePath } from '../../src/core/path-expand.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';

const DEFAULT_PACKAGE = 'jawcode@latest';
const DEFAULT_PREFIX = join(JAW_HOME, 'jwc-runtime');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function usage(): string {
    return `
  jaw jwc - optional external JWC runtime helper

  Usage:
    jaw jwc install [--prefix <dir>] [--package <pkg>] [--dry-run] [--json]
    jaw jwc clean   [--prefix <dir>] [--dry-run] [--json]
    jaw jwc doctor  [--prefix <dir>] [--json]

  Examples:
    jaw jwc install
    jaw jwc doctor
    jaw jwc clean

  Notes:
    - cli-jaw does not bundle JWC in npm or Electron installs.
    - install uses an external prefix: ${DEFAULT_PREFIX}
    - use the printed JWC_SDK_PATH before selecting JWC for chat.
`;
}

function fail(message: string, json = false): never {
    if (json) {
        console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
        console.error(`  ERROR ${message}`);
    }
    process.exit(1);
}

function normalizePrefix(value: unknown): string {
    const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_PREFIX;
    return resolveHomePath(raw, homedir());
}

function assertSafePrefix(prefix: string): void {
    const root = parse(prefix).root;
    const home = resolve(homedir());
    const jawHome = resolve(JAW_HOME);
    if (!prefix || prefix === root || prefix === home || prefix === jawHome || dirname(prefix) === root) {
        throw new Error(`Refusing unsafe JWC prefix: ${prefix}`);
    }
}

function posixExport(sdkPath: string): string {
    return `export JWC_SDK_PATH="${sdkPath.replace(/"/g, '\\"')}"`;
}

function powershellExport(sdkPath: string): string {
    return `$env:JWC_SDK_PATH="${sdkPath.replace(/"/g, '`"')}"`;
}

function fallbackSdkPath(prefix: string): string {
    return join(prefix, 'node_modules', 'jawcode', 'dist-node', 'sdk.js');
}

function resolveInstalledSdkPath(prefix: string): string {
    const resolverPath = join(prefix, '.resolve-jwc-sdk.mjs');
    const resolverSource = [
        "import { fileURLToPath } from 'node:url';",
        "const resolved = await import.meta.resolve('jawcode/sdk');",
        "console.log(resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved);",
        '',
    ].join('\n');
    try {
        writeFileSync(resolverPath, resolverSource, 'utf8');
        const out = execFileSync(process.execPath, [resolverPath], {
            cwd: prefix,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30_000,
        }).trim();
        if (out) return out;
    } finally {
        try { unlinkSync(resolverPath); } catch { /* best-effort cleanup */ }
    }
    return fallbackSdkPath(prefix);
}

function printGuidance(prefix: string, sdkPath: string): void {
    console.log(`  JWC external runtime path: ${prefix}`);
    console.log(`  SDK: ${sdkPath}`);
    console.log('');
    console.log('  Current shell:');
    console.log(`    ${posixExport(sdkPath)}`);
    console.log('');
    console.log('  PowerShell:');
    console.log(`    ${powershellExport(sdkPath)}`);
    console.log('');
    console.log('  Check:');
    console.log('    jaw jwc doctor');
    console.log('');
    console.log('  Remove external JWC dependencies:');
    console.log('    jaw jwc clean');
}

function commandArgs(): { command: string; values: Record<string, unknown> } {
    const args = process.argv.slice(3);
    const command = String(args[0] || 'help').toLowerCase();
    const parsed = parseArgs({
        args: args.slice(1),
        options: {
            prefix: { type: 'string' },
            package: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
        strict: true,
        allowPositionals: true,
    });
    return { command, values: parsed.values as Record<string, unknown> };
}

function runInstall(values: Record<string, unknown>): void {
    const json = values["json"] === true;
    const dryRun = values["dry-run"] === true;
    const prefix = normalizePrefix(values["prefix"]);
    const pkg = typeof values["package"] === 'string' && values["package"].trim()
        ? values["package"].trim()
        : DEFAULT_PACKAGE;

    try { assertSafePrefix(prefix); } catch (err) { fail((err as Error).message, json); }

    const npmArgs = ['install', '--prefix', prefix, pkg, '--omit=dev', '--no-audit', '--no-fund'];
    if (dryRun) {
        const sdkPath = fallbackSdkPath(prefix);
        const payload = { ok: true, dryRun: true, prefix, package: pkg, command: [npmBin, ...npmArgs], sdkPath };
        if (json) console.log(JSON.stringify(payload, null, 2));
        else {
            console.log(`  [dry-run] ${payload.command.join(' ')}`);
            printGuidance(prefix, sdkPath);
        }
        return;
    }

    mkdirSync(prefix, { recursive: true });
    execFileSync(npmBin, npmArgs, { stdio: 'inherit', timeout: 10 * 60_000 });
    const sdkPath = resolveInstalledSdkPath(prefix);
    if (json) {
        console.log(JSON.stringify({ ok: true, prefix, package: pkg, sdkPath }, null, 2));
    } else {
        printGuidance(prefix, sdkPath);
    }
}

function runClean(values: Record<string, unknown>): void {
    const json = values["json"] === true;
    const dryRun = values["dry-run"] === true;
    const prefix = normalizePrefix(values["prefix"]);
    try { assertSafePrefix(prefix); } catch (err) { fail((err as Error).message, json); }

    if (dryRun) {
        if (json) console.log(JSON.stringify({ ok: true, dryRun: true, prefix, exists: existsSync(prefix) }, null, 2));
        else console.log(`  [dry-run] remove ${prefix}`);
        return;
    }
    rmSync(prefix, { recursive: true, force: true });
    if (json) console.log(JSON.stringify({ ok: true, prefix, removed: true }, null, 2));
    else {
        console.log(`  Removed external JWC runtime: ${prefix}`);
        console.log('  cli-jaw npm/Electron bundles were not modified.');
    }
}

function runDoctor(values: Record<string, unknown>): void {
    const json = values["json"] === true;
    const prefix = normalizePrefix(values["prefix"]);
    const envSdk = process.env['JWC_SDK_PATH']?.trim() || '';
    const prefixSdk = fallbackSdkPath(prefix);
    const payload = {
        ok: true,
        bundled: false,
        prefix,
        prefixExists: existsSync(prefix),
        envSdkPath: envSdk || null,
        envSdkExists: envSdk ? existsSync(envSdk) : false,
        prefixSdkPath: prefixSdk,
        prefixSdkExists: existsSync(prefixSdk),
        installCommand: 'jaw jwc install',
        cleanCommand: 'jaw jwc clean',
    };
    if (json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
    }
    console.log('  JWC runtime: external-only');
    console.log(`  Prefix: ${prefix} ${payload.prefixExists ? '(exists)' : '(missing)'}`);
    console.log(`  JWC_SDK_PATH: ${envSdk || '(not set)'} ${payload.envSdkExists ? '(exists)' : ''}`.trimEnd());
    console.log(`  Prefix SDK: ${prefixSdk} ${payload.prefixSdkExists ? '(exists)' : '(missing)'}`);
    console.log('');
    console.log('  Install: jaw jwc install');
    console.log('  Clean:   jaw jwc clean');
}

if (shouldShowHelp(process.argv)) printAndExit(usage());

const { command, values } = commandArgs();
if (values["help"] === true || command === 'help') printAndExit(usage());

switch (command) {
    case 'install':
        runInstall(values);
        break;
    case 'clean':
        runClean(values);
        break;
    case 'doctor':
    case 'status':
        runDoctor(values);
        break;
    default:
        fail(`Unknown jwc subcommand: ${command}\n${usage()}`);
}
