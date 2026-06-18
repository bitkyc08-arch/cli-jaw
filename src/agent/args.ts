// ─── Agent CLI Argument Builders ──────────────────────
// Extracted from agent.js for 500-line compliance.

import { existsSync } from 'node:fs';
import os from 'node:os';
import { resolveCursorModelVariant } from './cursor-runtime.js';

const isCodexSparkModel = (model: string) => !!model && /spark/i.test(model);
const GEMINI_MAX_INCLUDE_DIRECTORIES = 5;
export const AGY_MAX_ADD_DIRECTORIES = 8;
export const AGY_PRINT_TIMEOUT = '10m';

export function formatAgyPrintTimeout(ms: number): string {
    const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 10 * 60_000;
    return `${Math.ceil(safeMs / 60_000)}m`;
}

// Claude Code fast mode is enabled by merging { fastMode: true } into the spawned
// CLI's settings via --settings (the claude analogue of codex's service_tier="fast").
// Gated on options.fastMode, which is sourced from perCli.<cli>.fastMode in spawn.ts.
const CLAUDE_FAST_MODE_SETTINGS = '{"fastMode":true}';
const AI_E_PROVIDERS = ['claude', 'codex', 'gemini', 'grok', 'copilot', 'kiro'] as const;
export type AiEProvider = typeof AI_E_PROVIDERS[number];

type BuildArgOptions = {
    fastMode?: boolean;
    sysPrompt?: string;
    includeDirectories?: string[];
    claudeBin?: string;
    homedir?: string;
    workingDir?: string;
    platform?: NodeJS.Platform;
    release?: string;
    env?: NodeJS.ProcessEnv;
    pathExists?: (path: string) => boolean;
    aiEProvider?: string;
    agyLogFile?: string;
    agyPrintTimeout?: string;
};

export function resolveAiEProvider(explicitProvider: string | null | undefined, model: string | null | undefined): AiEProvider {
    if (explicitProvider && (AI_E_PROVIDERS as readonly string[]).includes(explicitProvider)) {
        return explicitProvider as AiEProvider;
    }
    const value = model || '';
    if (!value || value === 'default') return 'claude';
    if (value.startsWith('gemini-')) return 'gemini';
    if (value.startsWith('grok-')) return 'grok';
    if (value.startsWith('copilot-') || value.includes('github')) return 'copilot';
    if (value.startsWith('gpt-') || value.includes('codex')) return 'codex';
    if (
        value === 'auto'
        || value.startsWith('deepseek-')
        || value.startsWith('minimax-')
        || value.startsWith('glm-')
        || value.startsWith('qwen3-')
    ) return 'kiro';
    return 'claude';
}

function buildAiEKiroArgs(model: string, prompt: string, sessionId?: string): string[] {
    const args = ['kiro', 'p', '--output-format', 'text', '--timeout-ms', '600000'];
    if (model && model !== 'default') args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
    args.push(prompt || '');
    return args;
}

function normalizePathForDedupe(dir: string): string {
    return dir.trim().replace(/[\\/]+$/, '');
}

function windowsPathToWslPath(dir: string): string | null {
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(dir.trim());
    if (!match) return null;
    const [, driveRaw, restRaw] = match;
    if (!driveRaw || restRaw === undefined) return null;
    const drive = driveRaw.toLowerCase();
    const rest = restRaw.replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
}

function isWslRuntime(options: BuildArgOptions): boolean {
    const platform = options.platform ?? process.platform;
    if (platform !== 'linux') return false;
    const env = options.env ?? process.env;
    const release = options.release ?? os.release();
    return Boolean(env['WSL_DISTRO_NAME'] || env['WSL_INTEROP'] || /microsoft|wsl/i.test(release));
}

function detectWslWindowsHome(options: BuildArgOptions): string[] {
    if (!isWslRuntime(options)) return [];
    const env = options.env ?? process.env;
    const pathExists = options.pathExists ?? existsSync;
    const candidates: string[] = [];
    const userProfileEnv = env['USERPROFILE'];
    const userProfile = userProfileEnv ? windowsPathToWslPath(userProfileEnv) : null;
    if (userProfile) candidates.push(userProfile);
    const user = env['USERNAME'] || env['USER'];
    if (user) candidates.push(`/mnt/c/Users/${user}`);
    return candidates.filter((dir) => pathExists(dir));
}

export function resolveGeminiIncludeDirectories(options: BuildArgOptions = {}): string[] {
    const dirs = [
        options.homedir ?? os.homedir(),
        ...detectWslWindowsHome(options),
        ...(options.includeDirectories ?? []),
    ];
    const seen = new Set<string>();
    const resolved: string[] = [];
    for (const dir of dirs) {
        const normalized = normalizePathForDedupe(dir || '');
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        resolved.push(normalized);
        if (resolved.length >= GEMINI_MAX_INCLUDE_DIRECTORIES) break;
    }
    return resolved;
}

function geminiIncludeDirectoryArgs(options: BuildArgOptions): string[] {
    return resolveGeminiIncludeDirectories(options)
        .flatMap((dir) => ['--include-directories', dir]);
}

export function resolveAgyAddDirectories(options: BuildArgOptions = {}): string[] {
    const dirs = [
        options.workingDir,
        options.homedir ?? os.homedir(),
        ...(options.includeDirectories ?? []),
    ];
    const seen = new Set<string>();
    const resolved: string[] = [];
    for (const dir of dirs) {
        const normalized = normalizePathForDedupe(dir || '');
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        resolved.push(normalized);
        if (resolved.length >= AGY_MAX_ADD_DIRECTORIES) break;
    }
    return resolved;
}

function agyAddDirArgs(options: BuildArgOptions): string[] {
    return resolveAgyAddDirectories(options)
        .flatMap((dir) => ['--add-dir', dir]);
}

function claudeFastModeArgs(options: BuildArgOptions): string[] {
    return options.fastMode ? ['--settings', CLAUDE_FAST_MODE_SETTINGS] : [];
}

/**
 * Session storage bucket — codex Spark lives in its own bucket so cross-model
 * resumes don't send a spark session_id to a gpt-5.4 run (or vice versa), which
 * would trigger `thread/resume failed: no rollout found` on the server side.
 */
export function resolveSessionBucket(cli: string | null | undefined, model: string | null | undefined, aiEProvider?: string | null): string {
    if (cli === 'ai-e') return `ai-e:${resolveAiEProvider(aiEProvider, model)}`;
    if (cli === 'claude-e') return 'claude-e';
    if (cli === 'codex-app') return 'codex-app';
    if (cli === 'grok') return 'grok';
    if (cli === 'pi') return 'pi';
    if (cli === 'codex' && isCodexSparkModel(model || '')) return 'codex-spark';
    return cli || '';
}

export function buildArgs(cli: string, model: string, effort: string, prompt: string, sysPrompt: string, permissions = 'auto', options: BuildArgOptions = {}) {
    const autoPerm = permissions === 'auto';
    switch (cli) {
        case 'agy':
            return ['-p', prompt || '',
                ...(model && model !== 'default' ? ['--model', model] : []),
                '--print-timeout', options.agyPrintTimeout || AGY_PRINT_TIMEOUT,
                ...(options.agyLogFile ? ['--log-file', options.agyLogFile] : []),
                ...(autoPerm ? ['--dangerously-skip-permissions'] : []),
                ...agyAddDirArgs(options)];
        case 'claude':
            return ['--print', '--verbose', '--output-format', 'stream-json',
                '--include-partial-messages',
                ...(autoPerm ? ['--dangerously-skip-permissions'] : []),
                '--max-turns', '500',
                ...(model && model !== 'default' ? ['--model', model] : []),
                ...(effort && effort !== 'medium' ? ['--effort', effort] : []),
                ...claudeFastModeArgs(options),
                ...(sysPrompt ? ['--append-system-prompt', sysPrompt] : [])];
        case 'claude-e': {
            const claudeExtraArgs: string[] = [];
            if (model && model !== 'default') claudeExtraArgs.push('--model', model);
            if (effort && effort !== 'medium') claudeExtraArgs.push('--effort', effort);
            if (sysPrompt) claudeExtraArgs.push('--append-system-prompt', sysPrompt);
            claudeExtraArgs.push(...claudeFastModeArgs(options));
            // claude-e can't interact with permission dialogs — always bypass
            if (autoPerm) claudeExtraArgs.push('--dangerously-skip-permissions');
            else claudeExtraArgs.push('--permission-mode', 'auto');
            return ['run', '--jsonl',
                '--output-format', 'stream-json',
                '--idle-timeout-ms', '600000',
                '--hard-timeout-ms', '3600000',
                ...(autoPerm ? ['--auto-accept-workspace-trust'] : []),
                ...(options.claudeBin ? ['--claude-bin', options.claudeBin] : []),
                ...(claudeExtraArgs.length ? ['--', ...claudeExtraArgs] : [])];
        }
        case 'ai-e': {
            const provider = resolveAiEProvider(options.aiEProvider, model);
            const isClaude = provider === 'claude';
            if (isClaude) {
                const claudeExtraArgs: string[] = [];
                if (model && model !== 'default') claudeExtraArgs.push('--model', model);
                if (effort && effort !== 'medium') claudeExtraArgs.push('--effort', effort);
                if (sysPrompt) claudeExtraArgs.push('--append-system-prompt', sysPrompt);
                claudeExtraArgs.push(...claudeFastModeArgs(options));
                if (autoPerm) claudeExtraArgs.push('--dangerously-skip-permissions');
                else claudeExtraArgs.push('--permission-mode', 'auto');
                return ['claude', 'run', '--jsonl',
                    '--output-format', 'stream-json',
                    '--idle-timeout-ms', '600000',
                    '--hard-timeout-ms', '3600000',
                    ...(autoPerm ? ['--auto-accept-workspace-trust'] : []),
                    ...(options.claudeBin ? ['--claude-bin', options.claudeBin] : []),
                    ...(claudeExtraArgs.length ? ['--', ...claudeExtraArgs] : [])];
            }
            if (provider === 'kiro') {
                return buildAiEKiroArgs(model, prompt || '');
            }

            const promptModeArgs = [
                provider,
                '--output-format', 'stream-json',
                '--timeout-ms', '600000',
            ];
            if (model && model !== 'default') promptModeArgs.push('--model', model);
            if (effort && effort !== 'medium' && provider !== 'gemini' && provider !== 'grok') {
                promptModeArgs.push('--effort', effort);
            }
            promptModeArgs.push(prompt || '');
            return promptModeArgs;
        }
        case 'codex': {
            const spark = isCodexSparkModel(model);
            const reasoningArgs = spark ? [] : [
                ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
                '-c', 'model_reasoning_summary="detailed"',
                '-c', 'hide_agent_reasoning=false',
                '-c', 'show_raw_agent_reasoning=true',
            ];
            // Spark is text-only at 128k context (per OpenAI launch post).
            // Pin 128k max + 110k auto-compact threshold so long turns auto-compact before overflow.
            const sparkContextArgs = spark ? [
                '-c', 'model_context_window=128000',
                '-c', 'model_auto_compact_token_limit=110000',
            ] : [];
            return ['exec',
                ...(model && model !== 'default' ? ['-m', model] : []),
                ...reasoningArgs,
                ...sparkContextArgs,
                '-c', `service_tier="${options.fastMode ? 'fast' : 'default'}"`,
                ...(autoPerm ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
                '--skip-git-repo-check', '--json'];
        }
        case 'cursor': {
            const cursorModel = resolveCursorModelVariant(model, effort);
            return ['-p',
                '--trust',
                '--output-format', 'stream-json',
                ...(cursorModel && cursorModel !== 'default' ? ['--model', cursorModel] : []),
                ...(autoPerm ? ['--force'] : []),
                prompt || ''];
        }
        case 'kiro-code':
            return ['chat', '--no-interactive',
                ...(autoPerm ? ['--trust-all-tools'] : []),
                ...(model && model !== 'default' ? ['--model', model] : []),
                prompt || ''];
        case 'gemini':
            return ['-p', prompt || '',
                ...(model && model !== 'default' ? ['-m', model] : []),
                '--skip-trust',
                '--approval-mode', 'yolo',
                ...geminiIncludeDirectoryArgs(options),
                '-o', 'stream-json'];
        case 'grok':
            return ['-p', prompt || '',
                ...(model && model !== 'default' ? ['-m', model] : []),
                '--output-format', 'streaming-json',
                '--no-alt-screen',
                ...(autoPerm ? ['--always-approve', '--permission-mode', 'bypassPermissions'] : [])];
        case 'codex-app':
            return ['app-server', '--listen', 'stdio://'];
        case 'opencode':
            return ['run',
                ...(model && model !== 'default' ? ['-m', model] : []),
                ...(effort ? ['--variant', effort] : []),
                '--thinking',
                '--format', 'json',
                prompt || ''];
        default:
            return [];
    }
}

export function buildResumeArgs(cli: string, model: string, effort: string, sessionId: string, prompt: string, permissions = 'auto', options: BuildArgOptions = {}) {
    const autoPerm = permissions === 'auto';
    switch (cli) {
        case 'agy':
            return [...(sessionId ? ['--conversation', sessionId] : []),
                '-p', prompt || '',
                ...(model && model !== 'default' ? ['--model', model] : []),
                '--print-timeout', options.agyPrintTimeout || AGY_PRINT_TIMEOUT,
                ...(options.agyLogFile ? ['--log-file', options.agyLogFile] : []),
                ...(autoPerm ? ['--dangerously-skip-permissions'] : []),
                ...agyAddDirArgs(options)];
        case 'claude':
            return ['--print', '--verbose', '--output-format', 'stream-json',
                '--include-partial-messages',
                ...(autoPerm ? ['--dangerously-skip-permissions'] : []),
                '--resume', sessionId,
                '--max-turns', '500',
                ...(model && model !== 'default' ? ['--model', model] : []),
                ...(effort && effort !== 'medium' ? ['--effort', effort] : []),
                ...claudeFastModeArgs(options),
                ...(options.sysPrompt ? ['--append-system-prompt', options.sysPrompt] : [])];
        case 'claude-e': {
            const claudeExtraArgs: string[] = [];
            if (model && model !== 'default') claudeExtraArgs.push('--model', model);
            if (effort && effort !== 'medium') claudeExtraArgs.push('--effort', effort);
            if (options.sysPrompt) claudeExtraArgs.push('--append-system-prompt', options.sysPrompt);
            claudeExtraArgs.push(...claudeFastModeArgs(options));
            if (autoPerm) claudeExtraArgs.push('--dangerously-skip-permissions');
            else claudeExtraArgs.push('--permission-mode', 'auto');
            return ['run', '--jsonl',
                '--output-format', 'stream-json',
                '--idle-timeout-ms', '600000',
                '--hard-timeout-ms', '3600000',
                ...(autoPerm ? ['--auto-accept-workspace-trust'] : []),
                ...(options.claudeBin ? ['--claude-bin', options.claudeBin] : []),
                '--resume', sessionId,
                ...(claudeExtraArgs.length ? ['--', ...claudeExtraArgs] : [])];
        }
        case 'ai-e': {
            const provider = resolveAiEProvider(options.aiEProvider, model);
            if (provider === 'kiro') {
                return buildAiEKiroArgs(model, prompt || '', sessionId);
            }
            if (provider !== 'claude') {
                // codex/grok/gemini/copilot: interactive mode with --resume
                const resumeArgs = [
                    provider,
                    '--output-format', 'stream-json',
                    '--timeout-ms', '600000',
                ];
                if (model && model !== 'default') resumeArgs.push('--model', model);
                if (effort && effort !== 'medium' && provider !== 'gemini' && provider !== 'grok') {
                    resumeArgs.push('--effort', effort);
                }
                if (sessionId) resumeArgs.push('--resume', sessionId);
                resumeArgs.push(prompt || '');
                return resumeArgs;
            }
            const claudeExtraArgs: string[] = [];
            if (model && model !== 'default') claudeExtraArgs.push('--model', model);
            if (effort && effort !== 'medium') claudeExtraArgs.push('--effort', effort);
            if (options.sysPrompt) claudeExtraArgs.push('--append-system-prompt', options.sysPrompt);
            claudeExtraArgs.push(...claudeFastModeArgs(options));
            if (autoPerm) claudeExtraArgs.push('--dangerously-skip-permissions');
            else claudeExtraArgs.push('--permission-mode', 'auto');
            return ['claude', 'run', '--jsonl',
                '--output-format', 'stream-json',
                '--idle-timeout-ms', '600000',
                '--hard-timeout-ms', '3600000',
                ...(autoPerm ? ['--auto-accept-workspace-trust'] : []),
                ...(options.claudeBin ? ['--claude-bin', options.claudeBin] : []),
                '--resume', sessionId,
                ...(claudeExtraArgs.length ? ['--', ...claudeExtraArgs] : [])];
        }
        case 'codex': {
            const spark = isCodexSparkModel(model);
            return ['exec', 'resume',
                ...(model && model !== 'default' ? ['--model', model] : []),
                ...(spark ? [] : ['-c', 'model_reasoning_summary="detailed"']),
                ...(spark ? [] : ['-c', 'hide_agent_reasoning=false']),
                ...(spark ? [] : ['-c', 'show_raw_agent_reasoning=true']),
                ...(spark ? ['-c', 'model_context_window=128000'] : []),
                ...(spark ? ['-c', 'model_auto_compact_token_limit=110000'] : []),
                '-c', `service_tier="${options.fastMode ? 'fast' : 'default'}"`,
                ...(autoPerm ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
                '--skip-git-repo-check',
                sessionId, prompt || '', '--json'];
        }
        case 'cursor': {
            const cursorModel = resolveCursorModelVariant(model, effort);
            return ['--resume', sessionId,
                '-p',
                '--trust',
                '--output-format', 'stream-json',
                ...(cursorModel && cursorModel !== 'default' ? ['--model', cursorModel] : []),
                ...(autoPerm ? ['--force'] : []),
                prompt || ''];
        }
        case 'kiro-code':
            return ['chat', '--no-interactive',
                '--resume-id', sessionId,
                ...(autoPerm ? ['--trust-all-tools'] : []),
                ...(model && model !== 'default' ? ['--model', model] : []),
                prompt || ''];
        case 'gemini':
            return ['--resume', sessionId,
                '-p', prompt || '',
                ...(model && model !== 'default' ? ['-m', model] : []),
                '--skip-trust',
                '--approval-mode', 'yolo',
                ...geminiIncludeDirectoryArgs(options),
                '-o', 'stream-json'];
        case 'grok':
            return ['-p', prompt || '',
                ...(sessionId ? ['--resume', sessionId] : []),
                ...(model && model !== 'default' ? ['-m', model] : []),
                '--output-format', 'streaming-json',
                '--no-alt-screen',
                ...(autoPerm ? ['--always-approve', '--permission-mode', 'bypassPermissions'] : [])];
        case 'codex-app':
            return ['app-server', '--listen', 'stdio://'];
        case 'opencode':
            return ['run', '-s', sessionId,
                ...(model && model !== 'default' ? ['-m', model] : []),
                ...(effort ? ['--variant', effort] : []),
                '--thinking',
                '--format', 'json',
                prompt || ''];
        default:
            return [];
    }
}
