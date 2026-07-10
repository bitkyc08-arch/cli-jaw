import fs from 'node:fs';
import path from 'node:path';
import { broadcast } from './bus.js';
import { JAW_HOME } from './config.js';

export const POLICY_LIMITS = {
    maxRules: 16,
    maxPatternChars: 200,
    maxReminderChars: 600,
    maxEvaluationChars: 256 * 1024,
} as const;

export type PolicyScope = 'main' | 'heartbeat';
export type PolicyAction = 'warn' | 'block' | 'redact';
export type PolicyVerdict = { ruleId: string; action: PolicyAction | 'size-warn' | 'forbidden-warn'; detail: string };
export type PolicyOutputRule = { id: string; action: PolicyAction; pattern: string; scopes?: PolicyScope[]; replacement?: string };
export type PolicyHooksConfig = {
    version?: number;
    enabled?: boolean;
    output?: { rules?: PolicyOutputRule[] };
    flags?: {
        recordPending?: { enabled?: boolean; toolPatterns?: string[]; clearPatterns?: string[]; reminder?: string };
        heartbeatQuietOk?: { enabled?: boolean; markers?: string[] };
    };
    beforeSpawn?: { promptSizeWarnChars?: number; forbiddenPatterns?: string[] };
};

export type PolicyOptions = { jawHome?: string; configPath?: string; env?: NodeJS.ProcessEnv };

function enabled(env: NodeJS.ProcessEnv): boolean {
    const value = env['CLI_JAW_POLICY_HOOKS'];
    return value !== '0' && value?.toLowerCase() !== 'false' && value?.toLowerCase() !== 'off';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function policyConfigPath(options: PolicyOptions = {}): string {
    return options.configPath || path.join(options.jawHome || JAW_HOME, 'policy-hooks.json');
}

export function loadPolicyHooksConfig(options: PolicyOptions = {}): PolicyHooksConfig | null {
    if (!enabled(options.env || process.env)) return null;
    const configPath = policyConfigPath(options);
    if (!fs.existsSync(configPath)) return null;
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!isRecord(parsed) || parsed['enabled'] === false) return null;
        return parsed as PolicyHooksConfig;
    } catch {
        return null;
    }
}

export function compilePolicyPattern(pattern: unknown, label: string): RegExp | null {
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > POLICY_LIMITS.maxPatternChars) return null;
    try {
        return new RegExp(pattern, 'g');
    } catch (error) {
        console.warn('[policy]', `invalid regex ${label}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

function emitVerdict(verdict: PolicyVerdict, channel?: string): void {
    console.warn('[policy]', verdict.ruleId, verdict.action, verdict.detail);
    broadcast('policy_verdict', { ...verdict, ...(channel ? { channel } : {}) }, 'internal');
}

export function applyOutputPolicy(
    text: string,
    input: { scope: PolicyScope; channel?: string },
    options: PolicyOptions = {},
): { text: string; verdicts: PolicyVerdict[] } {
    const config = loadPolicyHooksConfig(options);
    if (!config) return { text, verdicts: [] };
    const rules = Array.isArray(config.output?.rules) ? config.output.rules.slice(0, POLICY_LIMITS.maxRules) : [];
    const evaluated = text.slice(0, POLICY_LIMITS.maxEvaluationChars);
    let output = text;
    const verdicts: PolicyVerdict[] = [];
    for (const rule of rules) {
        if (!rule || typeof rule.id !== 'string' || !['warn', 'block', 'redact'].includes(rule.action)) continue;
        if (rule.scopes?.length && !rule.scopes.includes(input.scope)) continue;
        const regex = compilePolicyPattern(rule.pattern, rule.id);
        if (!regex || !regex.test(evaluated)) continue;
        const verdict: PolicyVerdict = { ruleId: rule.id.slice(0, 80), action: rule.action, detail: `matched ${input.scope} output` };
        verdicts.push(verdict);
        emitVerdict(verdict, input.channel);
        if (rule.action === 'block') {
            output = `[policy] output blocked by rule ${verdict.ruleId}`;
            break;
        }
        if (rule.action === 'redact') output = output.replace(regex, typeof rule.replacement === 'string' ? rule.replacement : '[redacted]');
    }
    return { text: output, verdicts };
}

export function runBeforeSpawnChecks(
    input: { cli: string; promptChars: number; prompt: string },
    options: PolicyOptions = {},
): PolicyVerdict[] {
    const config = loadPolicyHooksConfig(options);
    if (!config) return [];
    const verdicts: PolicyVerdict[] = [];
    const threshold = config.beforeSpawn?.promptSizeWarnChars;
    if (typeof threshold === 'number' && threshold > 0 && input.promptChars > threshold) {
        verdicts.push({ ruleId: 'prompt-size', action: 'size-warn', detail: `${input.cli} prompt ${input.promptChars} chars exceeds ${threshold}` });
    }
    for (const [index, pattern] of (config.beforeSpawn?.forbiddenPatterns || []).slice(0, POLICY_LIMITS.maxRules).entries()) {
        const regex = compilePolicyPattern(pattern, `beforeSpawn-${index}`);
        if (regex?.test(input.prompt.slice(0, POLICY_LIMITS.maxEvaluationChars))) {
            verdicts.push({ ruleId: `forbidden-${index}`, action: 'forbidden-warn', detail: `${input.cli} prompt matched forbidden pattern` });
        }
    }
    for (const verdict of verdicts) emitVerdict(verdict);
    return verdicts;
}

