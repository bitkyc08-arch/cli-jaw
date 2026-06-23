import fs from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CLI_KEYS, CLI_REGISTRY } from '../cli/registry.js';
import { resolveHomePath } from './path-expand.js';
import { detectCliBinary, listCliBinaryCandidates, selectSpawnableCliPath, type CliDetection } from './cli-detect.js';

function findPackageJson(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (dir !== dirname(dir)) {
        const candidate = join(dir, 'package.json');
        if (fs.existsSync(candidate)) return candidate;
        dir = dirname(dir);
    }
    throw new Error('package.json not found');
}

function getProjectDir(): string {
    return dirname(findPackageJson());
}

export function detectCli(name: string): CliDetection {
    const binary = (CLI_REGISTRY as Record<string, any>)[name]?.binary || name;
    if (name === 'kiro-code') return detectKiroCode();
    if (name === 'pi') return detectPi();
    if (name === 'ai-e' || binary === 'ai-e') return detectAiE();
    if (name !== 'claude-e' && binary !== 'claude-e' && binary !== 'claude-exec') {
        return detectCliBinary(binary);
    }
    return detectClaudeE();
}

function detectPi(): CliDetection {
    const explicit = process.env["PI_CODING_AGENT_BIN"];
    if (explicit) {
        const explicitDetected = detectCliBinary(explicit);
        if (explicitDetected.available) return explicitDetected;
    }
    const pathDetected = detectCliBinary('pi');
    if (pathDetected.available) return pathDetected;
    const npmDetected = detectCliBinary('npm');
    if (npmDetected.available) {
        return mergeRejectedDetections({
            available: true,
            path: npmDetected.path,
            rejected: [{ path: 'pi', reason: 'using npm-exec @earendil-works/pi-coding-agent fallback' }],
        }, pathDetected);
    }
    return mergeRejectedDetections({ available: false, path: null }, pathDetected, npmDetected);
}

function detectKiroCode(): CliDetection {
    const explicit = process.env["KIRO_CODE_BIN"];
    if (explicit) {
        const explicitDetected = detectCliBinary(explicit);
        if (explicitDetected.available) return explicitDetected;
    }
    const aliasDetected = detectCliBinary('kiro-code');
    if (aliasDetected.available) return aliasDetected;
    return detectCliBinary('kiro-cli');
}

function detectAiE(): CliDetection {
    const explicit = process.env["AI_E_BIN"];
    const explicitDetected = explicit
        ? selectCompatibleHelperPath([explicit], ['claude', 'run', '--help'])
        : { available: false, path: null } as CliDetection;
    if (explicitDetected.available) return explicitDetected;

    const packageDetected = selectCompatibleHelperPath(getAiEPackageCandidates(), ['claude', 'run', '--help']);
    if (packageDetected.available) return mergeRejectedDetections(packageDetected, explicitDetected);

    const pathDetected = selectCompatibleHelperPath(
        listCliBinaryCandidates('ai-e').candidates.map((candidate) => candidate.path),
        ['claude', 'run', '--help'],
    );
    if (pathDetected.available) return mergeRejectedDetections(pathDetected, explicitDetected, packageDetected);

    return mergeRejectedDetections({ available: false, path: null }, explicitDetected, pathDetected, packageDetected);
}

function detectClaudeE(): CliDetection {
    const explicitHelper = process.env["CLAUDE_E_BIN"] || process.env["CLAUDE_EXEC_BIN"] || process.env["JAW_CLAUDE_I_BIN"];
    const packageCandidates = getClaudeExecPackageCandidates();
    const packageDetected = selectCompatibleHelperPath(packageCandidates, ['run', '--help']);
    if (packageDetected.available) return packageDetected;

    const claudeEDetected = selectCompatibleHelperPath(
        listCliBinaryCandidates('claude-e').candidates.map((candidate) => candidate.path),
        ['run', '--help'],
    );
    if (claudeEDetected.available) return mergeRejectedDetections(claudeEDetected, packageDetected);

    const embeddedCandidates = getClaudeExecEmbeddedFallbackCandidates();
    const embeddedDetected = selectCompatibleHelperPath(embeddedCandidates, ['run', '--help']);
    if (embeddedDetected.available) return embeddedDetected;

    const claudeExecDetected = selectCompatibleHelperPath(
        listCliBinaryCandidates('claude-exec').candidates.map((candidate) => candidate.path),
        ['run', '--help'],
    );
    if (claudeExecDetected.available) {
        return mergeRejectedDetections(claudeExecDetected, packageDetected, claudeEDetected, embeddedDetected);
    }

    const legacyJawDetected = detectCliBinary('jaw-claude-i');
    if (legacyJawDetected.available) {
        return mergeRejectedDetections(legacyJawDetected, packageDetected, claudeEDetected, embeddedDetected, claudeExecDetected);
    }

    const legacyAliasDetected = detectCliBinary('claude-i');
    if (legacyAliasDetected.available) {
        return mergeRejectedDetections(legacyAliasDetected, packageDetected, claudeEDetected, embeddedDetected, claudeExecDetected, legacyJawDetected);
    }

    const nativeDetected = selectSpawnableCliPath(getClaudeExecNativeFallbackCandidates());
    if (nativeDetected.available) {
        return mergeRejectedDetections(nativeDetected, packageDetected, claudeEDetected, embeddedDetected, claudeExecDetected, legacyJawDetected, legacyAliasDetected);
    }

    const explicitDetected = explicitHelper && !packageCandidates.includes(explicitHelper) && !embeddedCandidates.includes(explicitHelper)
        ? selectSpawnableCliPath([explicitHelper])
        : null;
    return mergeRejectedDetections(
        { available: false, path: null },
        packageDetected,
        claudeEDetected,
        embeddedDetected,
        claudeExecDetected,
        legacyJawDetected,
        legacyAliasDetected,
        nativeDetected,
        explicitDetected,
    );
}

function getAiEPackageCandidates(): string[] {
    const helper = nativeExecutableName('ai-e');
    const jawHome = process.env['CLI_JAW_HOME']
        ? resolveHomePath(process.env['CLI_JAW_HOME'], homedir())
        : join(homedir(), '.cli-jaw');
    const candidates = [
        join(jawHome, 'providers', 'ai-e', 'node_modules', '@bitkyc08', 'ai-e', 'target', 'release', helper),
        join(jawHome, 'providers', 'ai-e', 'node_modules', '@bitkyc08', 'ai-e', 'target', 'debug', helper),
        join(getProjectDir(), 'node_modules', '@bitkyc08', 'ai-e', 'target', 'release', helper),
        join(getProjectDir(), 'node_modules', '@bitkyc08', 'ai-e', 'target', 'debug', helper),
        join(process.cwd(), 'node_modules', '@bitkyc08', 'ai-e', 'target', 'release', helper),
        join(process.cwd(), 'node_modules', '@bitkyc08', 'ai-e', 'target', 'debug', helper),
        join(getProjectDir(), '..', 'ai-e', 'target', 'release', helper),
        join(getProjectDir(), '..', 'ai-e', 'target', 'debug', helper),
        join(process.cwd(), '..', 'ai-e', 'target', 'release', helper),
        join(process.cwd(), '..', 'ai-e', 'target', 'debug', helper),
    ];
    return [...new Set(candidates)];
}

export function detectAllCli(): Record<string, CliDetection> {
    const out: Record<string, CliDetection> = {};
    for (const key of CLI_KEYS) out[key] = detectCli(key);
    return out;
}

function mergeRejectedDetections(result: CliDetection, ...sources: Array<CliDetection | null>): CliDetection {
    const rejected = sources
        .flatMap((source) => source?.rejected || [])
        .filter((entry) => entry.reason !== 'ENOENT');
    return {
        ...result,
        ...(rejected.length || result.rejected?.length
            ? { rejected: [...(result.rejected || []), ...rejected] }
            : {}),
    };
}

function nativeExecutableName(base: string): string {
    return process.platform === 'win32' ? `${base}.exe` : base;
}

export function getClaudeIHelperCandidates(
    projectDir = getProjectDir(),
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    return getClaudeExecHelperCandidates(projectDir, env);
}

export function getClaudeExecHelperCandidates(
    projectDir = getProjectDir(),
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    return [
        ...getClaudeExecEmbeddedCandidates(projectDir, env),
        ...getClaudeExecNativeFallbackCandidates(projectDir),
    ];
}

function getClaudeExecEmbeddedCandidates(
    projectDir = getProjectDir(),
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    return [
        ...getClaudeExecPackageCandidates(projectDir, env),
        ...getClaudeExecEmbeddedFallbackCandidates(projectDir),
    ];
}

function getClaudeExecPackageCandidates(
    projectDir = getProjectDir(),
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const shortHelper = nativeExecutableName('claude-e');
    const execHelper = nativeExecutableName('claude-exec');
    const candidates = [
        env["CLAUDE_E_BIN"],
        env["CLAUDE_EXEC_BIN"],
        env["JAW_CLAUDE_I_BIN"],
        join(projectDir, 'node_modules', 'claude-e', 'target', 'release', execHelper),
        join(projectDir, 'node_modules', 'claude-e', 'target', 'release', shortHelper),
        join(projectDir, 'node_modules', 'claude-e', 'target', 'debug', execHelper),
        join(projectDir, 'node_modules', 'claude-e', 'target', 'debug', shortHelper),
    ];
    return candidates.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
}

function selectCompatibleHelperPath(candidates: string[], helpArgs: string[]): CliDetection {
    const rejected: NonNullable<CliDetection['rejected']> = [];
    for (const candidate of [...new Set(candidates)]) {
        const detected = selectSpawnableCliPath([candidate]);
        if (!detected.available || !detected.path) {
            rejected.push(...(detected.rejected || [{ path: candidate, reason: 'not spawnable' }]));
            continue;
        }
        if (!helperSupportsIdleTimeout(detected.path, helpArgs)) {
            rejected.push({ path: detected.path, reason: 'missing --idle-timeout-ms support' });
            continue;
        }
        return {
            available: true,
            path: detected.path,
            ...(rejected.length ? { rejected } : {}),
        };
    }
    return {
        available: false,
        path: null,
        ...(rejected.length ? { rejected } : {}),
    };
}

function helperSupportsIdleTimeout(binaryPath: string, helpArgs: string[]): boolean {
    try {
        const output = execFileSync(binaryPath, helpArgs, {
            encoding: 'utf8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return output.includes('--idle-timeout-ms');
    } catch {
        return false;
    }
}

function getClaudeExecEmbeddedFallbackCandidates(projectDir = getProjectDir()): string[] {
    const shortHelper = nativeExecutableName('claude-e');
    const execHelper = nativeExecutableName('claude-exec');
    const legacyHelper = nativeExecutableName('jaw-claude-i');
    const legacyAlias = nativeExecutableName('claude-i');
    const platformArch = `${process.platform}-${process.arch}`;
    const candidates = [
        join(projectDir, 'vendor', platformArch, shortHelper),
        join(projectDir, 'vendor', platformArch, execHelper),
        join(projectDir, 'vendor', platformArch, legacyHelper),
        join(projectDir, 'vendor', platformArch, legacyAlias),
    ];
    return candidates.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
}

function getClaudeExecNativeFallbackCandidates(projectDir = getProjectDir()): string[] {
    const legacyHelper = nativeExecutableName('jaw-claude-i');
    const legacyAlias = nativeExecutableName('claude-i');
    const candidates = [
        join(projectDir, 'native', 'jaw-claude-i', 'target', 'release', legacyHelper),
        join(projectDir, 'native', 'jaw-claude-i', 'target', 'release', legacyAlias),
        join(projectDir, 'native', 'jaw-claude-i', 'target', 'debug', legacyHelper),
        join(projectDir, 'native', 'jaw-claude-i', 'target', 'debug', legacyAlias),
    ];
    return candidates.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
}
