// #299: a rebooted agent re-probed its host from zero, and a single failed
// probe (#298) turned a working tool into "the tool does not exist". Nothing
// durable recorded where anything actually lives.
//
// This resolves the document toolchain once per serve start and persists the
// answer, so the generated AGENTS.md can state absolute paths instead of skill
// blurbs. It never probes from the prompt build path — `regenerateB()` runs on
// every agent spawn, and putting subprocess lookups there would be a hot-path
// resource bug.
import fs from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { listCliBinaryCandidates, isSpawnableCliFile } from '../core/cli-detect.js';
import { getAdvancedMemoryDir } from './shared.js';
import { log } from '../core/logger.js';

/** The tools the document skills depend on, named by the issue. */
const TRACKED_TOOLS = ['officecli', 'soffice', 'python3', 'python', 'rg'] as const;

export type HostToolEntry = {
    name: string;
    path: string | null;
    spawnable: boolean;
    /** Why a tool that looks present is not usable, or how it was found. */
    note?: string;
};

export type HostToolchainRecord = {
    tools: HostToolEntry[];
    lastAttemptAt: string;
    /** Kept from the previous record when a scan finds nothing. */
    lastSuccessAt: string | null;
};

export function hostToolchainPath(): string {
    // Hidden: memory listing and indexing skip dotfiles, so this is a record,
    // not a document the agent can confuse for user content.
    return join(getAdvancedMemoryDir(), '.host-toolchain.json');
}

/**
 * The Microsoft Store ships `python.exe` / `python3.exe` aliases that open the
 * Store instead of running Python. They carry a real MZ header, so the ordinary
 * spawnable check accepts them, and the service PATH deliberately includes that
 * directory — reporting them as available sends the agent into a dead end.
 *
 * Matched on the exact parent directory rather than a substring: a project
 * directory that merely contains "WindowsApps" in its name is not a Store alias.
 */
export function isWindowsStoreAlias(candidatePath: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (process.platform !== 'win32') return false;
    const localAppData = env['LOCALAPPDATA'];
    if (!localAppData) return false;
    const storeDir = path.win32.join(localAppData, 'Microsoft', 'WindowsApps').toLowerCase();
    return path.win32.dirname(candidatePath).toLowerCase() === storeDir;
}

/**
 * LibreOffice installs its real executable inside the app bundle and does not
 * have to be on PATH. Reporting "not found" for a working install is worse than
 * saying nothing, so check the one canonical location before giving up.
 */
const MACOS_SOFFICE_PATH = '/Applications/LibreOffice.app/Contents/MacOS/soffice';

function resolveTool(name: string): HostToolEntry {
    const scan = listCliBinaryCandidates(name);
    for (const candidate of scan.candidates) {
        if ((name === 'python' || name === 'python3') && isWindowsStoreAlias(candidate.path)) {
            return {
                name,
                path: null,
                spawnable: false,
                note: `Microsoft Store alias at ${candidate.path} ignored — it opens the Store instead of running ${name}`,
            };
        }
        if (candidate.spawnable) return { name, path: candidate.path, spawnable: true };
    }

    if (name === 'soffice' && process.platform === 'darwin' && fs.existsSync(MACOS_SOFFICE_PATH)) {
        const check = isSpawnableCliFile(MACOS_SOFFICE_PATH);
        if (check.ok) {
            return { name, path: MACOS_SOFFICE_PATH, spawnable: true, note: 'found in the app bundle, not on PATH' };
        }
    }

    const firstReason = scan.candidates.find((c) => !c.spawnable)?.reason;
    const entry: HostToolEntry = { name, path: null, spawnable: false };
    const note = scan.scanError || firstReason;
    if (note) entry.note = note;
    return entry;
}

export function scanHostToolchain(tools: readonly string[] = TRACKED_TOOLS): HostToolEntry[] {
    return tools.map(resolveTool);
}

export function readHostToolchain(): HostToolchainRecord | null {
    try {
        const raw = fs.readFileSync(hostToolchainPath(), 'utf8');
        const parsed = JSON.parse(raw) as HostToolchainRecord;
        return Array.isArray(parsed?.tools) ? parsed : null;
    } catch { return null; }
}

/**
 * Merge a fresh scan over the stored record. A tool that failed to resolve this
 * time keeps its last known good path: the whole point of #299 is that one bad
 * probe must not erase knowledge that took real work to establish.
 */
export function mergeHostToolchain(
    previous: HostToolchainRecord | null,
    scanned: HostToolEntry[],
    now = new Date().toISOString(),
): HostToolchainRecord {
    const prior = new Map((previous?.tools ?? []).map((t) => [t.name, t]));
    const tools = scanned.map((entry) => {
        if (entry.spawnable) return entry;
        const before = prior.get(entry.name);
        if (before?.spawnable && before.path) {
            // Only trust the remembered path while the file is still there.
            if (fs.existsSync(before.path)) {
                return { ...before, note: 'from the last successful scan' };
            }
        }
        return entry;
    });
    // Only a FRESH resolution counts as success. Carrying a remembered path
    // forward keeps the record useful, but it is not new evidence, and letting
    // it advance the timestamp would make a permanently failing host look like
    // it verified cleanly every boot.
    const foundAny = scanned.some((t) => t.spawnable);
    return {
        tools,
        lastAttemptAt: now,
        lastSuccessAt: foundAny ? now : (previous?.lastSuccessAt ?? null),
    };
}

/** Runs once per serve start, before the first AGENTS.md is generated. */
export function refreshHostToolchain(): HostToolchainRecord | null {
    try {
        const merged = mergeHostToolchain(readHostToolchain(), scanHostToolchain());
        const target = hostToolchainPath();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(merged, null, 2));
        return merged;
    } catch (error) {
        // A scan failure must never block startup, and must never discard the
        // record we already had.
        log.warn('[toolchain] host scan failed:', (error as Error).message);
        return readHostToolchain();
    }
}

/** Renders the block injected into the generated AGENTS.md. Empty when unknown. */
export function renderHostToolchainSection(record: HostToolchainRecord | null): string {
    const tools = record?.tools ?? [];
    if (tools.length === 0) return '';
    const found = tools.filter((t) => t.spawnable && t.path);
    if (found.length === 0) return '';
    const lines = ['## Host toolchain', ''];
    lines.push('Resolved on this machine. Use these paths directly instead of re-probing.');
    lines.push('');
    for (const tool of tools) {
        if (tool.spawnable && tool.path) {
            lines.push(`- ${tool.name}: ${tool.path}${tool.note ? ` (${tool.note})` : ''}`);
        } else {
            lines.push(`- ${tool.name}: not found${tool.note ? ` — ${tool.note}` : ''}`);
        }
    }
    if (record?.lastAttemptAt) lines.push('', `verified_at: ${record.lastAttemptAt}`);
    return lines.join('\n');
}
