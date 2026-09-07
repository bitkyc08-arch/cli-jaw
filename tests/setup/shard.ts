// Pure helpers for tests/run.mts: argv parsing and deterministic shard partitioning.
//
// Kept free of side effects (no test-home setup, no node:test import) so a unit
// test can import it without starting a run. Partitioning is sorted round-robin:
// files are byte-ordered (LC_ALL=C semantics, Buffer.compare) and shard i of N
// takes every index where index % N === i - 1 — the same rule as Node's own
// --test-shard and the opencodex CI helper, so every runner computes the same
// disjoint, complete partition from the same file set.
import { Buffer } from 'node:buffer';

export const SCOPES = ['root', 'unit', 'integration', 'manager', 'browser', 'bin'] as const;
export type Scope = typeof SCOPES[number];
export interface Shard { index: number; total: number }
export interface RunnerOptions {
    all: boolean;
    watch: boolean;
    list: boolean;
    explicit: string[];
    scopes: Scope[];
    shard?: Shard;
}

function validateShard({ index, total }: Shard): void {
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total)
        || index < 1 || total < 1 || index > total) {
        throw new Error('--shard requires integers 1 <= i <= N');
    }
}

export function parseArgs(argv: readonly string[]): RunnerOptions {
    const options: RunnerOptions = { all: false, watch: false, list: false, explicit: [], scopes: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') { options.explicit.push(...argv.slice(i + 1)); break; }
        if (arg === '--all') { options.all = true; continue; }
        if (arg === '--watch') { options.watch = true; continue; }
        if (arg === '--list') { options.list = true; continue; }
        if (arg === '--shard' || arg === '--scope') {
            const value = argv[++i];
            if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
            if (arg === '--shard') {
                if (options.shard) throw new Error('--shard may appear only once');
                const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(value);
                if (!match) throw new Error('--shard requires i/N');
                options.shard = { index: Number(match[1]), total: Number(match[2]) };
                validateShard(options.shard);
            } else {
                for (const name of value.split(',')) {
                    const scope = SCOPES.find(s => s === name);
                    if (!scope) throw new Error(`unknown scope: ${name}; expected one of ${SCOPES.join(',')}`);
                    if (!options.scopes.includes(scope)) options.scopes.push(scope);
                }
            }
            continue;
        }
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        options.explicit.push(arg);
    }
    if (options.scopes.length && (options.all || options.explicit.length)) {
        throw new Error('--scope cannot be combined with --all or explicit paths');
    }
    if (options.watch && options.shard) throw new Error('--shard cannot be combined with --watch');
    if (options.watch && options.list) throw new Error('--list cannot be combined with --watch');
    return options;
}

// Inputs are '/'-separated paths (the caller normalizes). Returns a new array.
export function partitionFiles(files: readonly string[], shard?: Shard): string[] {
    if (shard) validateShard(shard);
    const sorted = [...new Set(files)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return shard ? sorted.filter((_, i) => i % shard.total === shard.index - 1) : sorted;
}

