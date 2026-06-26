import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export type AgyPrintFlag = '-p' | '--print' | '--prompt';

export type AgyCapabilities = {
    version?: string;
    print: boolean;
    printFlag?: AgyPrintFlag;
    conversation: boolean;
    model: boolean;
    printTimeout: boolean;
    logFile: boolean;
    addDir: boolean;
    dangerousSkipPermissions: boolean;
    sandbox: boolean;
    usedFallback?: boolean;
    probeError?: string;
};

export const DEFAULT_AGY_CAPABILITIES: AgyCapabilities = {
    print: true,
    printFlag: '-p',
    conversation: true,
    model: true,
    printTimeout: true,
    logFile: true,
    addDir: true,
    dangerousSkipPermissions: true,
    sandbox: false,
    usedFallback: true,
};

type CacheEntry = {
    mtimeMs: number;
    capabilities: AgyCapabilities;
};

const cache = new Map<string, CacheEntry>();

function hasLongFlag(text: string, flag: string): boolean {
    return new RegExp(`(^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'm').test(text);
}

function hasShortFlag(text: string, flag: string): boolean {
    return new RegExp(`(^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'm').test(text);
}

function parseAgyVersion(versionText = ''): string | undefined {
    return /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(versionText)?.[1];
}

function resolvePrintFlag(helpText: string): AgyPrintFlag | undefined {
    if (hasShortFlag(helpText, '-p')) return '-p';
    if (hasLongFlag(helpText, '--print')) return '--print';
    if (hasLongFlag(helpText, '--prompt')) return '--prompt';
    return undefined;
}

export function parseAgyHelp(helpText: string, versionText = ''): AgyCapabilities {
    const printFlag = resolvePrintFlag(helpText);
    const version = parseAgyVersion(versionText);
    return {
        ...(version ? { version } : {}),
        print: Boolean(printFlag),
        ...(printFlag ? { printFlag } : {}),
        conversation: hasLongFlag(helpText, '--conversation'),
        model: hasLongFlag(helpText, '--model'),
        printTimeout: hasLongFlag(helpText, '--print-timeout'),
        logFile: hasLongFlag(helpText, '--log-file'),
        addDir: hasLongFlag(helpText, '--add-dir'),
        dangerousSkipPermissions: hasLongFlag(helpText, '--dangerously-skip-permissions'),
        sandbox: hasLongFlag(helpText, '--sandbox'),
    };
}

function binaryMtimeMs(binary: string): number {
    try {
        return fs.statSync(binary).mtimeMs;
    } catch {
        return -1;
    }
}

function runAgyText(binary: string, args: string[]): string {
    const result = spawnSync(binary, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3_000,
    });
    if (result.error) throw result.error;
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.signal) throw new Error(`agy ${args.join(' ')} terminated by ${result.signal}`);
    if ((result.status ?? 0) !== 0 && !text.trim()) {
        throw new Error(`agy ${args.join(' ')} exited with status ${result.status}`);
    }
    return text;
}

function fallbackCapabilities(error: unknown): AgyCapabilities {
    const message = error instanceof Error ? error.message : String(error || 'unknown error');
    return { ...DEFAULT_AGY_CAPABILITIES, probeError: message };
}

export function detectAgyCapabilities(binary = 'agy'): AgyCapabilities {
    const key = binary || 'agy';
    const mtimeMs = binaryMtimeMs(key);
    const cached = cache.get(key);
    if (cached && cached.mtimeMs === mtimeMs) return cached.capabilities;
    let capabilities: AgyCapabilities;
    try {
        const helpText = runAgyText(key, ['--help']);
        const versionText = (() => {
            try {
                return runAgyText(key, ['--version']);
            } catch {
                return '';
            }
        })();
        capabilities = parseAgyHelp(helpText, versionText);
    } catch (error) {
        capabilities = fallbackCapabilities(error);
    }
    cache.set(key, { mtimeMs, capabilities });
    return capabilities;
}
