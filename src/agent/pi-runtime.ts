import fs from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { JAW_HOME } from '../core/config.js';
import { probeOpenCodexEndpointModels } from '../cli/opencodex-models.js';

export type PiProfileMode = 'basic' | 'openai' | 'anthropic' | 'vertex';
export type PiApiKind = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-vertex';

export type PiProfile = {
    id: string;
    label: string;
    mode: PiProfileMode;
    endpoint: string;
    apiKind: PiApiKind;
    apiKey?: string;
    model: string;
    reasoning?: boolean;
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
};

export type PiSettings = {
    defaultProfileId: string;
    profiles: PiProfile[];
    discoveredModels?: Record<string, string[]>;
};

export type PiCommand = {
    command: string;
    baseArgs: string[];
    source: 'env' | 'path' | 'npm-exec';
};

export interface PiModelDiscovery {
    models: string[];
    source: 'opencodex' | 'pi-offline';
}

export type PiRuntimeEvent =
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; text: string }
    | { kind: 'tool'; label: string; status?: string; detail?: string }
    | { kind: 'session'; sessionId: string };

export interface PiRpcSession {
    readonly child: ChildProcess;
    readonly alive: boolean;
    readonly abortEffective: boolean;
    sessionId: string | null;
    sendPrompt(message: string, opts?: {
        effort?: string;
        onEvent?: (event: PiRuntimeEvent) => void;
    }): Promise<{ text: string; stderr: string }>;
    abort(): Promise<void>;
    close(): void;
    kill(): void;
}

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i;
const PI_RPC_CAPABILITY_SCHEMA = 1;
const PI_RPC_CAPABILITY_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const PI_RPC_ABORT_TIMEOUT_MS = 15_000;

export const DEFAULT_PI_PROFILE: PiProfile = {
    id: 'progrok',
    label: 'Progrok',
    mode: 'basic',
    endpoint: 'http://127.0.0.1:18645/v1',
    apiKind: 'openai-completions',
    apiKey: 'dummy',
    model: 'grok-composer-2.5-fast',
    reasoning: true,
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
};

export const DEFAULT_PI_SETTINGS: PiSettings = {
    defaultProfileId: DEFAULT_PI_PROFILE.id,
    profiles: [DEFAULT_PI_PROFILE],
    discoveredModels: {
        [DEFAULT_PI_PROFILE.id]: ['grok-composer-2.5-fast', 'grok-4.5', 'grok-4.3'],
    },
};

function cleanId(input: unknown): string {
    const value = String(input || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!value) throw Object.assign(new Error('pi profile id required'), { statusCode: 400 });
    return value.slice(0, 80);
}

function trimString(input: unknown): string {
    return typeof input === 'string' ? input.trim() : '';
}

function modeToApiKind(mode: PiProfileMode): PiApiKind {
    if (mode === 'anthropic') return 'anthropic-messages';
    if (mode === 'vertex') return 'google-vertex';
    return 'openai-completions';
}

export function normalizePiEndpoint(input: string): { baseUrl: string; inferredApiKind: PiApiKind } {
    const raw = input.trim();
    if (!raw) throw Object.assign(new Error('endpoint required'), { statusCode: 400 });
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw Object.assign(new Error('invalid endpoint URL'), { statusCode: 400 });
    }
    let pathname = url.pathname.replace(/\/+$/, '');
    let inferredApiKind: PiApiKind = 'openai-completions';
    if (pathname.endsWith('/chat/completions')) {
        pathname = pathname.slice(0, -'/chat/completions'.length) || '/';
        inferredApiKind = 'openai-completions';
    } else if (pathname.endsWith('/responses')) {
        pathname = pathname.slice(0, -'/responses'.length) || '/';
        inferredApiKind = 'openai-responses';
    } else if (pathname.endsWith('/messages')) {
        pathname = pathname.slice(0, -'/messages'.length) || '/';
        inferredApiKind = 'anthropic-messages';
    }
    url.pathname = pathname || '/';
    url.search = '';
    url.hash = '';
    return { baseUrl: url.toString().replace(/\/$/, ''), inferredApiKind };
}

function isLocalEndpoint(endpoint: string): boolean {
    try {
        return LOCAL_HOST_RE.test(new URL(endpoint).hostname);
    } catch {
        return false;
    }
}

export function normalizePiProfile(input: unknown): PiProfile {
    const src = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const modeRaw = trimString(src['mode']) as PiProfileMode;
    const mode: PiProfileMode = ['basic', 'openai', 'anthropic', 'vertex'].includes(modeRaw) ? modeRaw : 'basic';
    const endpointInfo = normalizePiEndpoint(trimString(src['endpoint']));
    const model = trimString(src['model']);
    if (!model) throw Object.assign(new Error('model required'), { statusCode: 400 });
    const apiKeyInput = trimString(src['apiKey']);
    const apiKey = apiKeyInput || (isLocalEndpoint(endpointInfo.baseUrl) ? 'dummy' : '');
    if (!apiKey) throw Object.assign(new Error('api key required for remote Pi profile'), { statusCode: 400 });
    return {
        id: cleanId(src['id'] || src['provider'] || src['label'] || model),
        label: trimString(src['label']) || cleanId(src['id'] || src['provider'] || model),
        mode,
        endpoint: endpointInfo.baseUrl,
        apiKind: trimString(src['apiKind']) as PiApiKind || (mode === 'basic' ? endpointInfo.inferredApiKind : modeToApiKind(mode)),
        apiKey,
        model,
        reasoning: src['reasoning'] === undefined ? true : Boolean(src['reasoning']),
        supportsDeveloperRole: src['supportsDeveloperRole'] === undefined ? true : Boolean(src['supportsDeveloperRole']),
        supportsReasoningEffort: src['supportsReasoningEffort'] === undefined ? true : Boolean(src['supportsReasoningEffort']),
    };
}

export function normalizePiSettings(input: unknown): PiSettings {
    const src = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const rawProfiles = Array.isArray(src['profiles']) ? src['profiles'] : [];
    const profiles = rawProfiles.length
        ? rawProfiles.map((profile) => normalizePiProfile(profile))
        : [...DEFAULT_PI_SETTINGS.profiles];
    const defaultProfileId = trimString(src['defaultProfileId']) || profiles[0]?.id || DEFAULT_PI_PROFILE.id;
    const discoveredModels = src['discoveredModels'] && typeof src['discoveredModels'] === 'object'
        ? src['discoveredModels'] as Record<string, string[]>
        : { ...DEFAULT_PI_SETTINGS.discoveredModels };
    return { defaultProfileId, profiles, discoveredModels };
}

export function redactPiProfile(profile: PiProfile): Record<string, unknown> {
    const key = profile.apiKey || '';
    return {
        ...profile,
        apiKey: undefined,
        apiKeySet: Boolean(key),
        apiKeyLast4: key.slice(-4),
        apiKeySource: key ? 'settings' : 'none',
    };
}

export function redactPiSettings(input: unknown): Record<string, unknown> {
    const pi = normalizePiSettings(input);
    return {
        ...pi,
        profiles: pi.profiles.map(redactPiProfile),
    };
}

export function buildPiModelsConfig(pi: PiSettings, effort = ''): Record<string, unknown> {
    const providers: Record<string, unknown> = {};
    for (const profile of pi.profiles) {
        const modelIds = [...new Set([profile.model, ...(pi.discoveredModels?.[profile.id] || [])].filter(Boolean))];
        providers[profile.id] = {
            baseUrl: profile.endpoint,
            api: profile.apiKind,
            apiKey: profile.apiKey || 'dummy',
            compat: {
                supportsDeveloperRole: profile.supportsDeveloperRole !== false,
                supportsReasoningEffort: profile.supportsReasoningEffort !== false,
            },
            models: modelIds.map((modelId) => ({
                id: modelId,
                name: modelId,
                reasoning: profile.reasoning !== false,
                input: ['text'],
                contextWindow: modelId.includes('composer') ? 128000 : 1000000,
                maxTokens: 4096,
                ...(effort ? { defaultReasoningEffort: effort } : {}),
            })),
        };
    }
    return { providers };
}

export function buildPiAgentSettings(profile: PiProfile, effort = ''): Record<string, unknown> {
    return {
        defaultProvider: profile.id,
        defaultModel: profile.model,
        ...(effort ? { thinkingLevel: effort } : {}),
    };
}

export function ensurePiRuntimeConfig(piInput: unknown, profileId: string, effort = '', root = join(JAW_HOME, 'pi', 'runtime')): string {
    const pi = normalizePiSettings(piInput);
    const profile = pi.profiles.find((entry) => entry.id === profileId) || pi.profiles[0] || DEFAULT_PI_PROFILE;
    const dir = join(root, profile.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'models.json'), JSON.stringify(buildPiModelsConfig(pi, effort), null, 2));
    fs.writeFileSync(join(dir, 'settings.json'), JSON.stringify(buildPiAgentSettings(profile, effort), null, 2));
    return dir;
}

function commandWorks(command: string, args: string[], timeout = 3000, env: NodeJS.ProcessEnv = process.env): boolean {
    try {
        const result = spawnSync(command, args, { stdio: 'ignore', timeout, env });
        return result.status === 0;
    } catch {
        return false;
    }
}

export function resolvePiCommand(env: NodeJS.ProcessEnv = process.env): PiCommand {
    const explicit = trimString(env['PI_CODING_AGENT_BIN']);
    if (explicit) return { command: explicit, baseArgs: [], source: 'env' };
    if (commandWorks('pi', ['--version'], 3000, env)) return { command: 'pi', baseArgs: [], source: 'path' };
    return {
        command: 'npm',
        baseArgs: ['exec', '--yes', '--package', PI_PACKAGE, 'pi', '--'],
        source: 'npm-exec',
    };
}

function resolvePiCommandIdentity(command: PiCommand, env: NodeJS.ProcessEnv = process.env): string {
    const result = spawnSync(command.command, [...command.baseArgs, '--version'], {
        encoding: 'utf8',
        env,
        timeout: 15_000,
    });
    const version = `${result.stdout || ''}\n${result.stderr || ''}`.trim() || `exit:${String(result.status)}`;
    return JSON.stringify({ source: command.source, command: command.command, baseArgs: command.baseArgs, version });
}

function loadPiAbortEffective(profileId: string, command: PiCommand): boolean {
    try {
        const raw = JSON.parse(fs.readFileSync(join(JAW_HOME, 'pi', 'rpc-capabilities.json'), 'utf8')) as unknown;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
        const capability = raw as Record<string, unknown>;
        if (capability['schemaVersion'] !== PI_RPC_CAPABILITY_SCHEMA
            || capability['abortEffective'] !== true
            || capability['profileId'] !== profileId
            || capability['commandId'] !== resolvePiCommandIdentity(command)) return false;
        const probedAt = Date.parse(typeof capability['probedAt'] === 'string' ? capability['probedAt'] : '');
        return Number.isFinite(probedAt)
            && probedAt <= Date.now()
            && Date.now() - probedAt <= PI_RPC_CAPABILITY_MAX_AGE_MS;
    } catch {
        return false;
    }
}

export function parsePiModelList(output: string, profileId: string): string[] {
    const models = new Set<string>();
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || /^provider\s+model/i.test(line)) continue;
        const parts = line.split(/\s+/);
        if (parts[0] === profileId && parts[1]) models.add(parts[1]);
        else if (parts.length === 1 && parts[0] && !line.includes(' ')) models.add(parts[0]);
    }
    return [...models];
}

export function listPiModels(piInput: unknown, profileId: string, options: { effort?: string; root?: string; timeoutMs?: number } = {}): Promise<string[]> {
    const dir = ensurePiRuntimeConfig(piInput, profileId, options.effort || '', options.root);
    const cmd = resolvePiCommand();
    const isCmdShim = process.platform === 'win32' && !cmd.command.toLowerCase().endsWith('.exe');
    return new Promise((resolve, reject) => {
        const child = spawn(cmd.command, [...cmd.baseArgs, '--offline', '--list-models', profileId], {
            env: { ...process.env, PI_CODING_AGENT_DIR: dir },
            stdio: ['ignore', 'pipe', 'pipe'],
            ...(isCmdShim ? { shell: true } : {}),
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(Object.assign(new Error('pi model discovery timed out'), { statusCode: 504 }));
        }, options.timeoutMs ?? 20_000);
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk.toString(); });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(Object.assign(new Error(stderr.trim() || `pi list models failed with code ${code}`), { statusCode: 502 }));
                return;
            }
            resolve(parsePiModelList(`${stdout}\n${stderr}`, profileId));
        });
    });
}

export async function discoverPiProfileModels(
    piInput: unknown,
    profile: PiProfile,
    options: { effort?: string; root?: string; timeoutMs?: number } = {},
): Promise<PiModelDiscovery> {
    const openCodexModels = await probeOpenCodexEndpointModels(profile.endpoint, options.timeoutMs ?? 1500);
    if (openCodexModels) return { models: openCodexModels, source: 'opencodex' };

    const models = await listPiModels(piInput, profile.id, options);
    return { models, source: 'pi-offline' };
}

function extractTextOnly(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(extractTextOnly).join('');
    if (!value || typeof value !== 'object') return '';
    const obj = value as Record<string, unknown>;
    if (obj['type'] === 'thinking') return '';
    return extractTextOnly(obj['text']) || extractTextOnly(obj['delta']) || extractTextOnly(obj['content']) || extractTextOnly(obj['message']) || '';
}

function extractAssistantMessagesText(value: unknown): string {
    if (!Array.isArray(value)) return extractTextOnly(value);
    return value
        .filter((entry) => !!entry && typeof entry === 'object' && (entry as Record<string, unknown>)['role'] === 'assistant')
        .map(extractTextOnly)
        .join('');
}

export function parsePiRpcRecord(record: unknown): { done?: boolean; text?: string; thinking?: string; sessionId?: string; tool?: { label: string; status?: string; detail?: string } } {
    if (!record || typeof record !== 'object') return {};
    const obj = record as Record<string, unknown>;
    const type = typeof obj['type'] === 'string' ? obj['type'] : '';

    if (type === 'message_update') {
        const ame = obj['assistantMessageEvent'];
        if (ame && typeof ame === 'object') {
            const a = ame as Record<string, unknown>;
            const ameType = typeof a['type'] === 'string' ? a['type'] : '';
            if (ameType === 'thinking_delta') {
                const delta = typeof a['delta'] === 'string' ? a['delta'] : '';
                if (delta) return { thinking: delta };
                return {};
            }
            if (ameType === 'text_delta') {
                const delta = typeof a['delta'] === 'string' ? a['delta'] : '';
                if (delta) return { text: delta };
                return {};
            }
            if (ameType === 'toolcall_end') return {};
        }
        return {};
    }

    if (type === 'agent_end') {
        const finalText = extractAssistantMessagesText(obj['messages']);
        const sid = extractPiSessionId(obj);
        const base = sid ? { done: true, sessionId: sid } : { done: true };
        return finalText ? { ...base, text: finalText } : base;
    }

    if (type === 'tool_execution_end') {
        const name = trimString(obj['toolName'] || obj['name'] || obj['tool_name']) || 'Pi tool';
        const argsStr = obj['args'] != null ? JSON.stringify(obj['args']).slice(0, 2000) : '';
        const resultObj = obj['result'] && typeof obj['result'] === 'object' ? obj['result'] as Record<string, unknown> : null;
        const resultStr = resultObj
            ? extractToolResultText(resultObj).slice(0, 2000)
            : (obj['result'] != null ? JSON.stringify(obj['result']).slice(0, 2000) : '');
        const detail = [argsStr, resultStr].filter(Boolean).join('\n');
        const tool: { label: string; status: string; detail?: string } = { label: name, status: 'done' };
        if (detail) tool.detail = detail;
        return { tool };
    }

    const sid = extractPiSessionId(obj);
    if (sid) return { sessionId: sid };

    if (type === 'response') {
        const data = obj['data'] && typeof obj['data'] === 'object' ? obj['data'] as Record<string, unknown> : {};
        const dataSid = trimString(data['sessionId'] || data['session_id']);
        if (dataSid) return { sessionId: dataSid };
    }

    return {};
}


function extractToolResultText(result: Record<string, unknown>): string {
    const content = result['content'];
    if (!Array.isArray(content)) return typeof result['text'] === 'string' ? result['text'] : '';
    return content
        .filter((b) => b && typeof b === 'object' && (b as Record<string, unknown>)['type'] === 'text')
        .map((b) => String((b as Record<string, unknown>)['text'] || ''))
        .join('\n');
}

function extractPiSessionId(obj: Record<string, unknown>): string {
    return trimString(
        obj['session_id'] || obj['sessionId']
        || ((obj['data'] && typeof obj['data'] === 'object') ? (obj['data'] as Record<string, unknown>)['sessionId'] : '')
        || ((obj['result'] && typeof obj['result'] === 'object') ? (obj['result'] as Record<string, unknown>)['sessionId'] : '')
    );
}

type PersistentPrompt = {
    text: string;
    stderrStart: number;
    onEvent: ((event: PiRuntimeEvent) => void) | undefined;
    resolve: (result: { text: string; stderr: string }) => void;
    reject: (error: Error) => void;
};

type AbortWait = {
    id: number;
    accepted: boolean;
    terminal: boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
};

export function spawnPersistentPiRpc(profile: PiProfile, pi: PiSettings, options: {
    model: string;
    effort?: string;
    cwd: string;
    sessionId?: string;
    root?: string;
}): PiRpcSession {
    const dir = ensurePiRuntimeConfig(pi, profile.id, options.effort || '', options.root);
    const cmd = resolvePiCommand();
    const args = [
        ...cmd.baseArgs,
        '--mode', 'rpc',
        '--no-context-files',
        '--tools', 'read,bash,edit,write,grep,find,ls',
        '--provider', profile.id,
        '--model', options.model || profile.model,
        '--api-key', profile.apiKey || 'dummy',
        ...(options.sessionId ? ['--session-id', options.sessionId] : []),
    ];
    const isCmdShim = process.platform === 'win32' && !cmd.command.toLowerCase().endsWith('.exe');
    const child = spawn(cmd.command, args, {
        cwd: options.cwd,
        env: { ...process.env, PI_CODING_AGENT_DIR: dir },
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(isCmdShim ? { shell: true } : {}),
    });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let stderr = '';
    let seq = 1;
    let activePrompt: PersistentPrompt | null = null;
    let abortWait: AbortWait | null = null;
    let closed = false;

    const write = (type: string, fields: Record<string, unknown> = {}): number => {
        if (!session.alive || !child.stdin.writable) throw new Error('pi rpc session is not writable');
        const id = seq++;
        child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
        return id;
    };
    const settleAbort = (): void => {
        if (!abortWait || !abortWait.accepted || !abortWait.terminal) return;
        const wait = abortWait;
        abortWait = null;
        clearTimeout(wait.timer);
        wait.resolve();
    };
    const dispatchLine = (line: string): void => {
        let raw: unknown;
        try { raw = JSON.parse(line); }
        catch {
            console.warn(`[jaw:pi] JSON parse failed: ${line.slice(0, 200)}`);
            return;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const record = raw as Record<string, unknown>;
        if (abortWait && record['id'] === abortWait.id && record['type'] === 'response' && record['command'] === 'abort') {
            if (record['success'] === true) abortWait.accepted = true;
            else {
                const wait = abortWait;
                abortWait = null;
                clearTimeout(wait.timer);
                const error = record['error'] && typeof record['error'] === 'object'
                    ? trimString((record['error'] as Record<string, unknown>)['message'])
                    : '';
                wait.reject(new Error(error || 'pi rpc abort rejected'));
            }
        }
        const event = parsePiRpcRecord(record);
        const state = record['data'] && typeof record['data'] === 'object'
            ? record['data'] as Record<string, unknown>
            : null;
        const stateName = state && typeof state['state'] === 'string' ? state['state'].toLowerCase() : '';
        const nonRunning = Boolean(state) && (state?.['running'] === false
            || state?.['isRunning'] === false
            || (stateName !== '' && !['running', 'active', 'generating'].includes(stateName)));
        if (event.sessionId) {
            session.sessionId = event.sessionId;
            activePrompt?.onEvent?.({ kind: 'session', sessionId: event.sessionId });
        }
        if (event.tool) activePrompt?.onEvent?.({ kind: 'tool', ...event.tool });
        if (event.thinking) activePrompt?.onEvent?.({ kind: 'thinking', text: event.thinking });
        if (event.text && activePrompt && !(event.done && activePrompt.text)) {
            activePrompt.text += event.text;
            activePrompt.onEvent?.({ kind: 'text', text: event.text });
        }
        if (event.done || (abortWait && nonRunning)) {
            if (activePrompt) {
                const prompt = activePrompt;
                activePrompt = null;
                prompt.resolve({ text: prompt.text, stderr: stderr.slice(prompt.stderrStart) });
            }
            if (abortWait) abortWait.terminal = true;
        }
        settleAbort();
    };
    const rejectOutstanding = (error: Error): void => {
        if (activePrompt) {
            const prompt = activePrompt;
            activePrompt = null;
            prompt.reject(error);
        }
        if (abortWait) {
            const wait = abortWait;
            abortWait = null;
            clearTimeout(wait.timer);
            wait.reject(error);
        }
    };

    const session: PiRpcSession = {
        child,
        get alive() { return !closed && child.exitCode == null && !child.killed; },
        abortEffective: loadPiAbortEffective(profile.id, cmd),
        sessionId: options.sessionId || null,
        sendPrompt(message, opts = {}) {
            if (activePrompt) return Promise.reject(new Error('pi rpc prompt already active'));
            if (!session.alive) return Promise.reject(new Error('pi rpc session is not alive'));
            return new Promise((resolve, reject) => {
                activePrompt = { text: '', stderrStart: stderr.length, onEvent: opts.onEvent, resolve, reject };
                try {
                    if (opts.effort) write('set_thinking_level', { level: opts.effort });
                    write('prompt', { message });
                } catch (error) {
                    activePrompt = null;
                    reject(error as Error);
                }
            });
        },
        abort() {
            if (!activePrompt) return Promise.resolve();
            if (abortWait) return Promise.reject(new Error('pi rpc abort already active'));
            return new Promise((resolve, reject) => {
                let id: number;
                try { id = write('abort'); }
                catch (error) { reject(error as Error); return; }
                const timer = setTimeout(() => {
                    if (!abortWait || abortWait.id !== id) return;
                    abortWait = null;
                    reject(new Error('pi rpc abort timed out'));
                }, PI_RPC_ABORT_TIMEOUT_MS);
                abortWait = { id, accepted: false, terminal: false, resolve, reject, timer };
            });
        },
        close() {
            if (closed) return;
            try { child.stdin.end(); } catch { /* already closed */ }
            setTimeout(() => {
                if (child.exitCode == null && !child.killed) child.kill('SIGTERM');
            }, 750).unref();
        },
        kill() {
            if (child.exitCode == null && !child.killed) child.kill('SIGTERM');
        },
    };

    child.stdout?.on('data', (chunk) => {
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) dispatchLine(line.trim());
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => rejectOutstanding(error));
    child.on('close', (code) => {
        closed = true;
        buffer += decoder.end();
        if (buffer.trim()) dispatchLine(buffer.trim());
        rejectOutstanding(new Error(`pi rpc session exited with code ${String(code)}`));
    });
    write('get_state');
    if (options.effort) write('set_thinking_level', { level: options.effort });
    return session;
}

export function spawnPiRpc(profile: PiProfile, pi: PiSettings, options: {
    prompt: string;
    model: string;
    effort?: string;
    cwd: string;
    sysPrompt?: string;
    sessionId?: string;
    onEvent?: (event: PiRuntimeEvent) => void;
    root?: string;
}): { child: ChildProcess; done: Promise<{ text: string; code: number; sessionId?: string | null; stderr: string }> } {
    const dir = ensurePiRuntimeConfig(pi, profile.id, options.effort || '', options.root);
    const cmd = resolvePiCommand();
    const args = [
        ...cmd.baseArgs,
        '--mode', 'rpc',
        '--no-context-files',
        '--tools', 'read,bash,edit,write,grep,find,ls',
        '--provider', profile.id,
        '--model', options.model || profile.model,
        '--api-key', profile.apiKey || 'dummy',
        ...(options.sessionId ? ['--session-id', options.sessionId] : []),
    ];
    const isCmdShim = process.platform === 'win32' && !cmd.command.toLowerCase().endsWith('.exe');
    const child = spawn(cmd.command, args, {
        cwd: options.cwd,
        env: { ...process.env, PI_CODING_AGENT_DIR: dir },
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(isCmdShim ? { shell: true } : {}),
    });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let stderr = '';
    let text = '';
    let sessionId: string | null = null;
    let doneSettled = false;
    let seq = 1;
    const done = new Promise<{ text: string; code: number; sessionId?: string | null; stderr: string }>((resolve, reject) => {
        const finish = (code = 0) => {
            if (doneSettled) return;
            doneSettled = true;
            try { child.stdin.end(); } catch { /* already closed */ }
            setTimeout(() => {
                if (!child.killed && child.exitCode == null) child.kill('SIGTERM');
            }, 750);
            resolve({ text, code, sessionId, stderr });
        };
        let parseFailures = 0;
        const dispatchLine = (line: string) => {
            let parsed: unknown;
            try { parsed = JSON.parse(line); }
            catch {
                parseFailures++;
                console.warn(`[jaw:pi] JSON parse failed (${parseFailures}): ${line.slice(0, 200)}`);
                return;
            }
            const event = parsePiRpcRecord(parsed);
            if (event.sessionId) {
                sessionId = event.sessionId;
                options.onEvent?.({ kind: 'session', sessionId });
            }
            if (event.tool) options.onEvent?.({ kind: 'tool', ...event.tool });
            if (event.thinking) options.onEvent?.({ kind: 'thinking', text: event.thinking });
            if (event.text && !(event.done && text)) {
                text += event.text;
                options.onEvent?.({ kind: 'text', text: event.text });
            }
            if (event.done) finish(0);
        };
        child.on('error', reject);
        child.stdout.on('data', (chunk) => {
            buffer += decoder.write(chunk);
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) if (line.trim()) dispatchLine(line.trim());
        });
        child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk.toString(); });
        child.on('close', (code) => {
            if (buffer.trim()) dispatchLine(buffer.trim());
            finish(code ?? 0);
        });
    });
    const write = (type: string, fields: Record<string, unknown> = {}) => {
        child.stdin.write(JSON.stringify({ id: seq++, type, ...fields }) + '\n');
    };
    write('get_state');
    if (options.effort) write('set_thinking_level', { level: options.effort });
    const fullPrompt = options.sysPrompt ? `${options.sysPrompt}\n\n${options.prompt}` : options.prompt;
    const hasHistory = fullPrompt.includes('[Recent Context]');
    console.log(`[jaw:pi] prompt len=${fullPrompt.length}, hasHistory=${hasHistory}, effort=${options.effort || 'none'}, sessionId=${options.sessionId || 'new'}`);
    write('prompt', { message: fullPrompt });
    return { child, done };
}
