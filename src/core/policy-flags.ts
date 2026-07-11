import fs from 'node:fs';
import path from 'node:path';
import { JAW_HOME } from './config.js';
import { compilePolicyPattern, loadPolicyHooksConfig, POLICY_LIMITS, type PolicyOptions } from './policy-hooks.js';

type RecordPendingFlag = { set: boolean; evidence: string; setAt: string; consumedAt?: string };
type PolicyFlagsFile = { flags: { record_pending?: RecordPendingFlag } };

function flagsPath(options: PolicyOptions): string {
    return path.join(options.jawHome || JAW_HOME, 'policy-flags.json');
}

function readFlags(options: PolicyOptions): PolicyFlagsFile {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(flagsPath(options), 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as PolicyFlagsFile;
    } catch { /* missing/invalid state is empty */ }
    return { flags: {} };
}

function writeFlags(value: PolicyFlagsFile, options: PolicyOptions): void {
    const target = flagsPath(options);
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(value, null, 2));
        fs.renameSync(temp, target);
    } catch (error) {
        console.warn('[policy]', `flag write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function matches(patterns: string[], text: string, label: string): boolean {
    const input = text.slice(0, POLICY_LIMITS.maxEvaluationChars);
    return patterns.slice(0, POLICY_LIMITS.maxRules).some((pattern, index) => compilePolicyPattern(pattern, `${label}-${index}`)?.test(input) === true);
}

export function evaluateRecordPending(toolLog: unknown, finalText: string, options: PolicyOptions = {}): void {
    const config = loadPolicyHooksConfig(options);
    const rule = config?.flags?.recordPending;
    if (!rule?.enabled) return;
    const state = readFlags(options);
    if (matches(rule.clearPatterns || [], finalText, 'record-clear')) {
        if (state.flags.record_pending?.set) {
            state.flags.record_pending.set = false;
            writeFlags(state, options);
        }
        return;
    }
    const serializedToolLog = JSON.stringify(toolLog).slice(0, POLICY_LIMITS.maxEvaluationChars);
    if (matches(rule.toolPatterns || [], serializedToolLog, 'record-tool')) {
        const evidence = serializedToolLog.slice(0, 400);
        state.flags.record_pending = { set: true, evidence, setAt: new Date().toISOString() };
        writeFlags(state, options);
    }
}

/** Set a deterministic recording obligation when a structured runner report requests it. */
export function setRecordPending(evidence: string, options: PolicyOptions = {}): void {
    const state = readFlags(options);
    state.flags.record_pending = { set: true, evidence: evidence.slice(0, 400), setAt: new Date().toISOString() };
    writeFlags(state, options);
}

export function consumePendingReminder(options: PolicyOptions = {}): string | null {
    const config = loadPolicyHooksConfig(options);
    const rule = config?.flags?.recordPending;
    if (!rule?.enabled) return null;
    const state = readFlags(options);
    const flag = state.flags.record_pending;
    if (!flag?.set) return null;
    flag.consumedAt = new Date().toISOString();
    writeFlags(state, options);
    const reminder = typeof rule.reminder === 'string' ? rule.reminder.slice(0, POLICY_LIMITS.maxReminderChars) : 'A recording obligation is still pending.';
    return `[POLICY FLAG] record_pending\n${reminder}`;
}

export function inspectPolicyFlags(options: PolicyOptions = {}): unknown {
    return readFlags(options);
}
