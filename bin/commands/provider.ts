/**
 * cli-jaw provider — on-demand provider runtime installer.
 *
 * Providers removed from optionalDependencies can be installed into a
 * JAW_HOME-owned prefix, similar to `jaw jwc`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { JAW_HOME } from '../../src/core/config.js';
import { resolveHomePath } from '../../src/core/path-expand.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';

interface ProviderSpec {
    name: string;
    package: string;
    binary: string;
    description: string;
}

const PROVIDERS: Record<string, ProviderSpec> = {
    'ai-e': {
        name: 'ai-e',
        package: '@bitkyc08/ai-e@latest',
        binary: 'ai-e',
        description: 'AI-E multi-provider PTY runtime helper',
    },
};

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function usage(): string {
    const names = Object.keys(PROVIDERS).join(', ');
    return `
  jaw provider — on-demand provider runtime helper

  Usage:
    jaw provider install <name> [--prefix <dir>] [--dry-run] [--json]
    jaw provider clean <name>   [--prefix <dir>] [--dry-run] [--json]
    jaw provider doctor <name>  [--json]
    jaw provider list           [--json]

  Available providers: ${names}

  Examples:
    jaw provider install ai-e
    jaw provider doctor ai-e
    jaw provider clean ai-e
    jaw provider list

  Notes:
    - Installs into an external prefix: ~/.cli-jaw/providers/<name>/
    - The binary is detected via PATH or the provider prefix automatically.
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

function resolveProvider(name: string | undefined, json = false): ProviderSpec {
    if (!name || !PROVIDERS[name]) {
        const available = Object.keys(PROVIDERS).join(', ');
        fail(`Unknown provider: ${name || '(none)'}. Available: ${available}`, json);
    }
    return PROVIDERS[name];
}

function defaultPrefix(providerName: string): string {
    return join(JAW_HOME, 'providers', providerName);
}

function normalizePrefix(value: unknown, providerName: string): string {
    const raw = typeof value === 'string' && value.trim() ? value.trim() : defaultPrefix(providerName);
    return resolveHomePath(raw, homedir());
}

function assertSafePrefix(prefix: string): void {
    const root = parse(prefix).root;
    const home = resolve(homedir());
    const jawHome = resolve(JAW_HOME);
    if (!prefix || prefix === root || prefix === home || prefix === jawHome || dirname(prefix) === root) {
        throw new Error(`Refusing unsafe provider prefix: ${prefix}`);
    }
}

function commandArgs(): { command: string; providerName: string | undefined; values: Record<string, unknown> } {
    const args = process.argv.slice(3);
    const command = String(args[0] || 'help').toLowerCase();
    const providerName = args[1] && !args[1].startsWith('-') ? args[1].toLowerCase() : undefined;
    const parseStart = providerName ? 2 : 1;
    const parsed = parseArgs({
        args: args.slice(parseStart),
        options: {
            prefix: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
        strict: true,
        allowPositionals: true,
    });
    return { command, providerName, values: parsed.values as Record<string, unknown> };
}

function runInstall(providerName: string | undefined, values: Record<string, unknown>): void {
    const json = values['json'] === true;
    const dryRun = values['dry-run'] === true;
    const spec = resolveProvider(providerName, json);
    const prefix = normalizePrefix(values['prefix'], spec.name);
    try { assertSafePrefix(prefix); } catch (err) { fail((err as Error).message, json); }

    const npmArgs = ['install', '--prefix', prefix, spec.package, '--omit=dev', '--no-audit', '--no-fund'];
    if (dryRun) {
        const payload = { ok: true, dryRun: true, provider: spec.name, prefix, package: spec.package, command: [npmBin, ...npmArgs] };
        if (json) console.log(JSON.stringify(payload, null, 2));
        else console.log(`  [dry-run] ${payload.command.join(' ')}`);
        return;
    }

    mkdirSync(prefix, { recursive: true });
    console.log(`  Installing ${spec.name} (${spec.package})...`);
    execFileSync(npmBin, npmArgs, { stdio: 'inherit', timeout: 10 * 60_000 });
    if (json) {
        console.log(JSON.stringify({ ok: true, provider: spec.name, prefix, package: spec.package }, null, 2));
    } else {
        console.log(`  ${spec.name} installed at: ${prefix}`);
        console.log(`  The runtime will be detected automatically via jaw doctor.`);
    }
}

function runClean(providerName: string | undefined, values: Record<string, unknown>): void {
    const json = values['json'] === true;
    const dryRun = values['dry-run'] === true;
    const spec = resolveProvider(providerName, json);
    const prefix = normalizePrefix(values['prefix'], spec.name);
    try { assertSafePrefix(prefix); } catch (err) { fail((err as Error).message, json); }

    if (dryRun) {
        if (json) console.log(JSON.stringify({ ok: true, dryRun: true, provider: spec.name, prefix, exists: existsSync(prefix) }, null, 2));
        else console.log(`  [dry-run] remove ${prefix}`);
        return;
    }
    rmSync(prefix, { recursive: true, force: true });
    if (json) console.log(JSON.stringify({ ok: true, provider: spec.name, prefix, removed: true }, null, 2));
    else console.log(`  Removed ${spec.name} provider runtime: ${prefix}`);
}

function runDoctor(providerName: string | undefined, values: Record<string, unknown>): void {
    const json = values['json'] === true;
    const spec = resolveProvider(providerName, json);
    const prefix = defaultPrefix(spec.name);
    const payload = {
        ok: true,
        provider: spec.name,
        prefix,
        prefixExists: existsSync(prefix),
        installCommand: `jaw provider install ${spec.name}`,
        cleanCommand: `jaw provider clean ${spec.name}`,
    };
    if (json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
    }
    console.log(`  Provider: ${spec.name} — ${spec.description}`);
    console.log(`  Prefix: ${prefix} ${payload.prefixExists ? '(installed)' : '(not installed)'}`);
    console.log(`  Install: ${payload.installCommand}`);
    console.log(`  Clean:   ${payload.cleanCommand}`);
}

function runList(values: Record<string, unknown>): void {
    const json = values['json'] === true;
    const entries = Object.values(PROVIDERS).map((spec) => ({
        name: spec.name,
        package: spec.package,
        installed: existsSync(defaultPrefix(spec.name)),
        prefix: defaultPrefix(spec.name),
    }));
    if (json) {
        console.log(JSON.stringify({ ok: true, providers: entries }, null, 2));
        return;
    }
    for (const entry of entries) {
        const status = entry.installed ? '(installed)' : '(not installed)';
        console.log(`  ${entry.name}: ${entry.package} ${status}`);
    }
}

if (shouldShowHelp(process.argv)) printAndExit(usage());

const { command, providerName, values } = commandArgs();
if (values['help'] === true || command === 'help') printAndExit(usage());

switch (command) {
    case 'install':
        runInstall(providerName, values);
        break;
    case 'clean':
        runClean(providerName, values);
        break;
    case 'doctor':
    case 'status':
        runDoctor(providerName, values);
        break;
    case 'list':
    case 'ls':
        runList(values);
        break;
    default:
        fail(`Unknown provider subcommand: ${command}\n${usage()}`);
}
