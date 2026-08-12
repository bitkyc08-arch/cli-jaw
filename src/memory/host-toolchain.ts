import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listCliBinaryCandidates } from '../core/cli-detect.js';
import { launchSpec } from '../core/exec-name.js';

export const HOST_TOOLCHAIN_START = '<!-- cli-jaw:host-toolchain:start -->';
export const HOST_TOOLCHAIN_END = '<!-- cli-jaw:host-toolchain:end -->';
export const HOST_TOOLCHAIN_PROMPT_BUDGET = 1800;
export const HOST_TOOLCHAIN_PATH_CANDIDATE_LIMIT = 6;

export const HOST_TOOL_NAMES = ['officecli', 'soffice', 'python', 'ripgrep'] as const;
export type HostToolName = typeof HOST_TOOL_NAMES[number];
export type HostToolVerification =
    | 'verified'
    | 'not-found'
    | 'rejected-store-stub'
    | 'verification-failed'
    | 'discovery-failed';

export interface HostToolEntry {
    path: string | null;
    version: string | null;
    source: string;
    verified_at: string;
    verification: HostToolVerification;
}

export interface HostToolchainProfile {
    schema_version: 1;
    verified_at: string;
    tools: Record<HostToolName, HostToolEntry>;
}

interface ToolCandidate {
    path: string;
    source: string;
}

interface CandidateDiscovery {
    candidates: ToolCandidate[];
    scanError?: boolean;
}

interface VerificationAttempt {
    ok: boolean;
    version?: string | null;
    missing?: boolean;
}

export interface HostToolchainContext {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    workingDir?: string;
}

export interface HostToolchainDeps {
    now?: () => Date;
    discover?: (tool: HostToolName) => CandidateDiscovery;
    verify?: (tool: HostToolName, candidatePath: string) => VerificationAttempt;
}

const VERSION_ARGS: Record<HostToolName, string[]> = {
    officecli: ['--version'],
    soffice: ['--version'],
    python: ['--version'],
    ripgrep: ['--version'],
};

const ENV_PATHS: Record<HostToolName, string[]> = {
    officecli: ['OFFICECLI_BIN'],
    soffice: ['SOFFICE_BIN', 'LIBREOFFICE_BIN'],
    python: ['PYTHON'],
    ripgrep: ['CLI_JAW_RIPGREP_PATH'],
};

function pathNames(tool: HostToolName, platform: NodeJS.Platform): string[] {
    if (tool === 'python') return platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
    if (tool === 'soffice') return ['soffice', 'libreoffice'];
    if (tool === 'ripgrep') return ['rg'];
    return ['officecli'];
}

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
    return platform === 'win32' ? path.win32 : path.posix;
}

function boundedText(value: unknown, maxChars: number): string {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxChars);
}

function boundedPathText(value: unknown, maxChars: number): string {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, maxChars);
}

function extractSafeVersion(stdout: unknown, stderr: unknown): string | null {
    const text = `${String(stdout || '')}\n${String(stderr || '')}`;
    const match = text.match(/(?:^|\s)v?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/m);
    return match?.[1]?.slice(0, 64) || null;
}

function canonicalCandidate(candidate: string, platform: NodeJS.Platform, workingDir: string): string | null {
    const api = pathApi(platform);
    const raw = boundedPathText(candidate, 1024);
    if (!raw) return null;
    const absolute = api.isAbsolute(raw) ? api.normalize(raw) : api.resolve(workingDir, raw);
    return api.isAbsolute(absolute) ? absolute : null;
}

function isInsideWindowsPath(candidate: string, root: string): boolean {
    const normalizedCandidate = path.win32.resolve(candidate).toLowerCase();
    const normalizedRoot = path.win32.resolve(root).toLowerCase();
    const rel = path.win32.relative(normalizedRoot, normalizedCandidate);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.win32.isAbsolute(rel));
}

/** WindowsApps python.exe/python3.exe are App Execution Alias redirectors, not interpreters. */
export function isWindowsStorePythonRedirector(
    candidate: string,
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    if (platform !== 'win32') return false;
    const name = path.win32.basename(candidate).toLowerCase();
    if (name !== 'python.exe' && name !== 'python3.exe' && name !== 'python') return false;
    const roots = [
        env['LOCALAPPDATA'] ? path.win32.join(env['LOCALAPPDATA'], 'Microsoft', 'WindowsApps') : '',
        env['USERPROFILE'] ? path.win32.join(env['USERPROFILE'], 'AppData', 'Local', 'Microsoft', 'WindowsApps') : '',
    ].filter(Boolean);
    return roots.some(root => isInsideWindowsPath(candidate, root));
}

function addCandidate(out: ToolCandidate[], candidatePath: string | undefined, source: string): void {
    if (!candidatePath?.trim()) return;
    out.push({ path: candidatePath.trim(), source });
}

function listImmediateDirectories(root: string, limit = 20): string[] {
    try {
        return fs.readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .slice(0, limit)
            .map(entry => path.join(root, entry.name));
    } catch {
        return [];
    }
}

function bundledRipgrepCandidates(homeDir: string, platform: NodeJS.Platform): string[] {
    const binary = platform === 'win32' ? 'rg.exe' : 'rg';
    const out: string[] = [];
    const roots = [
        path.join(homeDir, '.bun', 'install', 'global', 'node_modules', '@openai'),
        path.join(homeDir, '.npm-global', 'lib', 'node_modules', '@openai'),
    ];
    for (const root of roots) {
        for (const pkg of listImmediateDirectories(root)) {
            if (!path.basename(pkg).startsWith('codex-')) continue;
            for (const target of listImmediateDirectories(path.join(pkg, 'vendor'), 10)) {
                out.push(path.join(target, 'path', binary));
            }
        }
    }
    return out;
}

function knownCandidates(
    tool: HostToolName,
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    homeDir: string,
    workingDir: string,
): string[] {
    const executable = platform === 'win32' ? '.exe' : '';
    const out = [
        path.join(workingDir, 'bin', tool === 'ripgrep' ? `rg${executable}` : `${tool}${executable}`),
        path.join(homeDir, 'bin', tool === 'ripgrep' ? `rg${executable}` : `${tool}${executable}`),
    ];

    if (platform === 'win32') {
        const programFiles = [env['ProgramFiles'], env['ProgramFiles(x86)']].filter(Boolean) as string[];
        if (tool === 'soffice') {
            out.push(...programFiles.map(root => path.win32.join(root, 'LibreOffice', 'program', 'soffice.exe')));
            if (env['LOCALAPPDATA']) {
                out.push(path.win32.join(env['LOCALAPPDATA'], 'Programs', 'LibreOffice', 'program', 'soffice.exe'));
            }
        }
        if (tool === 'python' && env['LOCALAPPDATA']) {
            const pythonRoot = path.win32.join(env['LOCALAPPDATA'], 'Programs', 'Python');
            out.push(...listImmediateDirectories(pythonRoot).map(dir => path.join(dir, 'python.exe')));
        }
    } else if (platform === 'darwin') {
        if (tool === 'soffice') out.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
    } else {
        if (tool === 'soffice') out.push('/usr/bin/soffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice');
        if (tool === 'python') out.push('/usr/bin/python3', '/usr/local/bin/python3');
        if (tool === 'ripgrep') out.push('/usr/bin/rg', '/usr/local/bin/rg');
    }
    if (tool === 'ripgrep') out.push(...bundledRipgrepCandidates(homeDir, platform));
    return out;
}

function defaultDiscover(
    tool: HostToolName,
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    homeDir: string,
    workingDir: string,
): CandidateDiscovery {
    const candidates: ToolCandidate[] = [];
    for (const envName of ENV_PATHS[tool]) addCandidate(candidates, env[envName], `env:${envName}`);

    let scanError = false;
    const pathCandidateKeys = new Set<string>();
    for (const name of pathNames(tool, platform)) {
        const scan = listCliBinaryCandidates(name, env['PATH'] || env['Path'] || env['path'] || '');
        scanError ||= !!scan.scanError;
        for (const candidate of scan.candidates) {
            const key = platform === 'win32' ? candidate.path.toLowerCase() : candidate.path;
            if (pathCandidateKeys.has(key)) continue;
            if (pathCandidateKeys.size >= HOST_TOOLCHAIN_PATH_CANDIDATE_LIMIT) continue;
            pathCandidateKeys.add(key);
            addCandidate(candidates, candidate.path, 'PATH');
        }
    }
    for (const candidate of knownCandidates(tool, platform, env, homeDir, workingDir)) {
        addCandidate(candidates, candidate, 'known-location');
    }
    return { candidates, ...(scanError ? { scanError: true } : {}) };
}

function defaultVerify(
    tool: HostToolName,
    candidatePath: string,
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
): VerificationAttempt {
    if (tool === 'python' && isWindowsStorePythonRedirector(candidatePath, platform, env)) return { ok: false };
    try {
        const stat = fs.statSync(candidatePath);
        if (!stat.isFile()) return { ok: false };
        if (platform !== 'win32') fs.accessSync(candidatePath, fs.constants.X_OK);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { ok: false, missing: code === 'ENOENT' || code === 'ENOTDIR' };
    }

    try {
        const spec = launchSpec(candidatePath, VERSION_ARGS[tool]);
        const result = spawnSync(spec.file, spec.args, {
            encoding: 'utf8',
            timeout: 1800,
            windowsHide: true,
            env,
        });
        if (result.error || result.status !== 0) return { ok: false };
        return { ok: true, version: extractSafeVersion(result.stdout, result.stderr) };
    } catch {
        return { ok: false };
    }
}

function isKnownVerification(value: unknown): value is HostToolVerification {
    return [
        'verified',
        'not-found',
        'rejected-store-stub',
        'verification-failed',
        'discovery-failed',
    ].includes(String(value));
}

function validatedEntry(value: unknown): HostToolEntry | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Partial<HostToolEntry>;
    if (!isKnownVerification(raw.verification)) return null;
    const entryPath = raw.path === null ? null : boundedPathText(raw.path, 1024);
    if (raw.path !== null && !entryPath) return null;
    return {
        path: entryPath,
        version: raw.version === null ? null : boundedText(raw.version, 64) || null,
        source: boundedText(raw.source, 80) || 'unknown',
        verified_at: boundedText(raw.verified_at, 64),
        verification: raw.verification,
    };
}

export function parseHostToolchainProfile(content: string): HostToolchainProfile | null {
    const start = content.indexOf(HOST_TOOLCHAIN_START);
    const end = content.indexOf(HOST_TOOLCHAIN_END, start + HOST_TOOLCHAIN_START.length);
    if (start < 0 || end < 0) return null;
    const block = content.slice(start + HOST_TOOLCHAIN_START.length, end);
    const json = /```json\s*([\s\S]*?)```/i.exec(block)?.[1];
    if (!json) return null;
    try {
        const raw = JSON.parse(json) as Partial<HostToolchainProfile>;
        const tools = {} as Record<HostToolName, HostToolEntry>;
        for (const tool of HOST_TOOL_NAMES) {
            const entry = validatedEntry(raw.tools?.[tool]);
            if (!entry) return null;
            tools[tool] = entry;
        }
        return {
            schema_version: 1,
            verified_at: boundedText(raw.verified_at, 64),
            tools,
        };
    } catch {
        return null;
    }
}

export function renderHostToolchainManagedBlock(profile: HostToolchainProfile): string {
    return `${HOST_TOOLCHAIN_START}\n## Host Toolchain\n\n`
        + `\`\`\`json\n${JSON.stringify(profile, null, 2)}\n\`\`\`\n${HOST_TOOLCHAIN_END}`;
}

export function mergeHostToolchainProfileContent(existing: string, profile: HostToolchainProfile): string {
    const block = renderHostToolchainManagedBlock(profile);
    const start = existing.indexOf(HOST_TOOLCHAIN_START);
    const end = existing.indexOf(HOST_TOOLCHAIN_END, start + HOST_TOOLCHAIN_START.length);
    if (start >= 0 && end >= start) {
        return existing.slice(0, start) + block + existing.slice(end + HOST_TOOLCHAIN_END.length);
    }
    return `${existing.trimEnd()}\n\n${block}\n`;
}

export function stripHostToolchainManagedBlock(content: string): string {
    const start = content.indexOf(HOST_TOOLCHAIN_START);
    const end = content.indexOf(HOST_TOOLCHAIN_END, start + HOST_TOOLCHAIN_START.length);
    if (start < 0 || end < 0) return content;
    return (content.slice(0, start) + content.slice(end + HOST_TOOLCHAIN_END.length))
        .replace(/\n{3,}/g, '\n\n');
}

export function resolveHostToolchainProfile(
    previous: HostToolchainProfile | null,
    context: HostToolchainContext = {},
    deps: HostToolchainDeps = {},
): HostToolchainProfile {
    const platform = context.platform ?? process.platform;
    const env = context.env ?? process.env;
    const homeDir = context.homeDir ?? os.homedir();
    const workingDir = context.workingDir ?? process.cwd();
    const now = (deps.now ?? (() => new Date()))().toISOString();
    const discover = deps.discover
        ?? ((tool: HostToolName) => defaultDiscover(tool, platform, env, homeDir, workingDir));
    const verify = deps.verify
        ?? ((tool: HostToolName, candidatePath: string) => defaultVerify(tool, candidatePath, platform, env));
    const tools = {} as Record<HostToolName, HostToolEntry>;

    for (const tool of HOST_TOOL_NAMES) {
        const cached = previous?.tools[tool];
        if (cached?.verification === 'verified' && cached.path) {
            const cachedPath = canonicalCandidate(cached.path, platform, workingDir);
            if (cachedPath && !(tool === 'python' && isWindowsStorePythonRedirector(cachedPath, platform, env))) {
                const checked = verify(tool, cachedPath);
                if (checked.ok) {
                    tools[tool] = {
                        path: cachedPath,
                        version: checked.version ?? cached.version,
                        source: cached.source,
                        verified_at: now,
                        verification: 'verified',
                    };
                    continue;
                }
            }
        }

        const found = discover(tool);
        let sawStoreStub = false;
        let sawVerificationFailure = false;
        const seen = new Set<string>();
        for (const candidate of found.candidates) {
            const candidatePath = canonicalCandidate(candidate.path, platform, workingDir);
            if (!candidatePath) continue;
            const key = platform === 'win32' ? candidatePath.toLowerCase() : candidatePath;
            if (seen.has(key)) continue;
            seen.add(key);
            if (tool === 'python' && isWindowsStorePythonRedirector(candidatePath, platform, env)) {
                sawStoreStub = true;
                continue;
            }
            const checked = verify(tool, candidatePath);
            if (!checked.ok) {
                sawVerificationFailure ||= checked.missing !== true;
                continue;
            }
            tools[tool] = {
                path: candidatePath,
                version: checked.version ?? null,
                source: boundedText(candidate.source, 80) || 'discovery',
                verified_at: now,
                verification: 'verified',
            };
            break;
        }
        if (!tools[tool]) {
            tools[tool] = {
                path: null,
                version: null,
                source: 'discovery',
                verified_at: now,
                verification: sawStoreStub
                    ? 'rejected-store-stub'
                    : sawVerificationFailure
                        ? 'verification-failed'
                        : found.scanError
                            ? 'discovery-failed'
                            : 'not-found',
            };
        }
    }

    return { schema_version: 1, verified_at: now, tools };
}

export function refreshHostToolchainProfileFile(
    profilePath: string,
    context: HostToolchainContext = {},
    deps: HostToolchainDeps = {},
): HostToolchainProfile {
    const existing = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
    const profile = resolveHostToolchainProfile(parseHostToolchainProfile(existing), context, deps);
    const next = mergeHostToolchainProfileContent(existing, profile);
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    if (next !== existing) fs.writeFileSync(profilePath, next, 'utf8');
    return profile;
}

function promptPath(value: string): string {
    return `\`${boundedPathText(value, 420).replaceAll('`', '\\`')}\``;
}

export function renderHostToolchainPromptBlock(
    profile: HostToolchainProfile | null,
    maxChars = HOST_TOOLCHAIN_PROMPT_BUDGET,
): string {
    if (!profile) return '';
    const lines = [
        '## Host toolchain',
        '- Use a `verified` absolute path directly; skip discovery first. If fast invocation fails, rediscover and refresh the profile.',
    ];
    for (const tool of HOST_TOOL_NAMES) {
        const entry = profile.tools[tool];
        if (entry.verification === 'verified' && entry.path) {
            const version = entry.version ? `; version ${boundedText(entry.version, 64)}` : '';
            lines.push(`- ${tool}: ${promptPath(entry.path)} (verified${version}; source ${boundedText(entry.source, 80)}; ${boundedText(entry.verified_at, 64)})`);
        } else {
            lines.push(`- ${tool}: unavailable (${entry.verification}; checked ${boundedText(entry.verified_at, 64)})`);
        }
    }
    const rendered = lines.join('\n');
    const budget = Math.max(0, maxChars);
    const suffix = '\n...(truncated)';
    if (rendered.length <= budget) return rendered;
    if (budget <= suffix.length) return suffix.slice(0, budget);
    return `${rendered.slice(0, budget - suffix.length)}${suffix}`;
}
