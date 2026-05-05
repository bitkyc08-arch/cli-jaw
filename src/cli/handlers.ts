// ─── Slash Command Handlers ─────────────────────────
// Extracted from commands.js for 500-line compliance.

import { CLI_KEYS, buildModelChoicesByCli } from './registry.js';
import { t } from '../core/i18n.js';
import { detectCli, settings } from '../core/config.js';
import type { CliCommandContext } from './command-context.js';
import type { SlashCommand, SlashResult } from './types.js';
export { compactHandler } from './compact.js';

const DEFAULT_CLI_CHOICES = [...CLI_KEYS];
const MODEL_CHOICES_BY_CLI = buildModelChoicesByCli();

function toChoiceKey(value: unknown) {
    return String(value || '').trim().toLowerCase();
}

function dedupeChoices<T>(list: T[]): T[] {
    const out: T[] = [];
    const seen = new Set<string>();
    for (const entry of list || []) {
        const candidate: unknown = entry && typeof entry === 'object'
            ? (entry as { value?: unknown }).value ?? entry
            : entry;
        const key = toChoiceKey(candidate);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
    }
    return out;
}

function getCliChoicesFromContext(ctx: CliCommandContext): string[] {
    const s = (ctx as unknown as { settings?: { perCli?: Record<string, unknown> } }).settings;
    const keys = Object.keys(s?.perCli || {});
    return keys.length ? keys : DEFAULT_CLI_CHOICES;
}

function getModelChoicesFromContext(ctx: CliCommandContext): string[] {
    const s = (ctx as unknown as {
        settings?: { cli?: string; perCli?: Record<string, { model?: string } | undefined> };
    }).settings;
    const fromCatalog = (Object.values(MODEL_CHOICES_BY_CLI) as string[][]).flat();
    const fromSettings = Object.values(s?.perCli || {})
        .map((v) => v?.model)
        .filter((m): m is string => Boolean(m));
    const activeCli = s?.cli || '';
    const currentModel = s?.perCli?.[activeCli]?.model;
    return dedupeChoices([...fromCatalog, ...fromSettings, ...(currentModel ? [currentModel] : [])]);
}

async function safeCall<T>(
    fn: (() => Promise<T> | T) | undefined | null,
    fallback: T | null = null,
): Promise<T | null> {
    if (typeof fn !== 'function') return fallback;
    try {
        return await fn();
    } catch (err: unknown) {
        if (process.env["DEBUG"]) console.warn('[commands:safeCall]', (err as Error).message);
        return fallback;
    }
}

export function formatDuration(seconds: unknown) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '-';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

export function unknownCommand(name: string, locale = 'ko'): SlashResult {
    return {
        ok: false,
        type: 'error',
        code: 'unknown_command',
        text: t('cmd.unknown', { name }, locale),
    };
}

export function unsupportedCommand(cmd: SlashCommand, iface: string, locale = 'ko'): SlashResult {
    return {
        ok: false,
        type: 'error',
        code: 'unsupported_interface',
        text: t('cmd.unsupported', { name: cmd.name, iface }, locale),
    };
}

export function normalizeResult(result: unknown): SlashResult {
    if (!result) return { ok: true, type: 'success', text: '' };
    if (typeof result === 'string') return { ok: true, type: 'info', text: result };
    if (typeof result === 'object') {
        const r = result as Record<string, unknown>;
        const ok = r["ok"] !== false;
        const type = (typeof r["type"] === 'string' && r["type"]) || (ok ? 'success' : 'error');
        return { ...r, ok, type };
    }
    return { ok: true, type: 'info', text: String(result) };
}

// ─── Individual Handlers ─────────────────────────────
// helpHandler is kept in commands.js (needs COMMANDS/findCommand access)

export async function statusHandler(_args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const [settings, session, runtime, skills] = await Promise.all([
        safeCall(ctx.getSettings, null),
        safeCall(ctx.getSession, null),
        safeCall(ctx.getRuntime, null),
        safeCall(ctx.getSkills, null),
    ]) as [
        Record<string, unknown> | null,
        Record<string, unknown> | null,
        Record<string, unknown> | null,
        Array<{ enabled?: boolean }> | null,
    ];

    const cli = (settings?.["cli"] as string | undefined) || (session?.["active_cli"] as string | undefined) || 'unknown';
    const overrideModel = (settings?.["activeOverrides"] as Record<string, { model?: string }> | undefined)?.[cli]?.model;
    const sessionCli = (session?.["active_cli"] || session?.["activeCli"]) as string | undefined;
    const sessionModel = session?.["model"] && (!sessionCli || sessionCli === cli)
        ? (session["model"] as string)
        : undefined;
    const model = overrideModel
        || sessionModel
        || (settings?.["perCli"] as Record<string, { model?: string }> | undefined)?.[cli]?.model
        || 'default';
    const overrideEffort = (settings?.["activeOverrides"] as Record<string, { effort?: string }> | undefined)?.[cli]?.effort;
    const sessionEffort = session?.["effort"] && (!sessionCli || sessionCli === cli)
        ? (session["effort"] as string)
        : undefined;
    const effort = overrideEffort
        || sessionEffort
        || (settings?.["perCli"] as Record<string, { effort?: string }> | undefined)?.[cli]?.effort
        || '-';
    const activeAgent = runtime?.["activeAgent"];
    const agent = activeAgent === true
        ? '● running'
        : activeAgent === false ? '○ idle' : '-';
    const queuePending = runtime?.["queuePending"] ?? '-';
    const uptime = formatDuration(runtime?.["uptimeSec"]);
    const activeSkills = Array.isArray(skills) ? skills.filter(s => s.enabled).length : '-';
    const refSkills = Array.isArray(skills) ? skills.filter(s => !s.enabled).length : '-';

    const fb = (settings?.["fallbackOrder"] as string[] | undefined) || [];

    return {
        ok: true,
        type: 'info',
        text: [
            `🦈 cli-jaw v${(ctx as { version?: string }).version || 'unknown'}`,
            `CLI:      ${cli}`,
            `Model:    ${model}`,
            `Effort:   ${effort || '-'}`,
            ...(fb.length ? [`Fallback: ${fb.join(' → ')}`] : []),
            `Uptime:   ${uptime}`,
            `Agent:    ${agent}`,
            `Queue:    ${queuePending}`,
            `Skills:   ${activeSkills} active, ${refSkills} ref`,
        ].join('\n'),
    };
}

export async function modelHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const settings = await safeCall(ctx.getSettings, null) as Record<string, unknown> | null;
    if (!settings) return { ok: false, text: t('cmd.settingsLoadFail', {}, L) };

    const activeCli = (settings["cli"] as string | undefined) || 'claude';
    const session = await safeCall(ctx.getSession, null) as Record<string, unknown> | null;
    const sessionCli = (session?.["active_cli"] || session?.["activeCli"]) as string | undefined;
    const overrideModel = (settings["activeOverrides"] as Record<string, { model?: string }> | undefined)?.[activeCli]?.model;
    const sessionModel = session?.["model"] && (!sessionCli || sessionCli === activeCli)
        ? (session["model"] as string)
        : undefined;
    const current = overrideModel
        || sessionModel
        || (settings["perCli"] as Record<string, { model?: string }> | undefined)?.[activeCli]?.model
        || 'default';

    if (!args.length) {
        return { ok: true, text: t('cmd.model.current', { cli: activeCli, model: current }, L) };
    }

    const nextModel = args.join(' ').trim();
    if (!nextModel || nextModel.length > 200 || /[\r\n]/.test(nextModel)) {
        return { ok: false, text: t('cmd.model.invalid', {}, L) };
    }

    const perCli = (settings["perCli"] as Record<string, Record<string, unknown>> | undefined) || {};
    const nextPerCli = {
        ...perCli,
        [activeCli]: {
            ...(perCli[activeCli] || {}),
            model: nextModel,
        },
    };
    const updateResult = await ctx.updateSettings({ perCli: nextPerCli }) as SlashResult;
    if (updateResult?.ok === false) return updateResult;
    return {
        ok: true,
        text: t('cmd.model.changed', { model: nextModel }, L),
    };
}

export async function cliHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const settings = await safeCall(ctx.getSettings, null) as Record<string, unknown> | null;
    if (!settings) return { ok: false, text: t('cmd.settingsLoadFail', {}, L) };

    const allowed = Object.keys((settings["perCli"] as Record<string, unknown> | undefined) || {});
    const fallbackAllowed = allowed.length ? allowed : DEFAULT_CLI_CHOICES;
    const current = (settings["cli"] as string | undefined) || 'claude';

    if (!args.length) {
        return {
            ok: true,
            text: t('cmd.cli.current', { cli: current, available: fallbackAllowed.join(', ') }, L),
        };
    }

    const nextCli = args[0]!.toLowerCase();
    if (!fallbackAllowed.includes(nextCli)) {
        return {
            ok: false,
            text: t('cmd.cli.unknown', { cli: nextCli, available: fallbackAllowed.join(', ') }, L),
        };
    }

    if (nextCli === current) {
        return { ok: true, text: t('cmd.cli.already', { cli: nextCli }, L) };
    }

    const updateResult = await ctx.updateSettings({ cli: nextCli }) as SlashResult;
    if (updateResult?.ok === false) return updateResult;
    return { ok: true, text: t('cmd.cli.changed', { from: current, to: nextCli }, L) };
}

export async function thoughtHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const settings = await safeCall(ctx.getSettings, null) as Record<string, unknown> | null;
    if (!settings) return { ok: false, text: t('cmd.settingsLoadFail', {}, ctx.locale || 'ko') };

    const sub = String(args[0] || '').toLowerCase();
    if (!sub || sub === 'status') {
        return {
            ok: true,
            text: `Gemini thought visibility: ${settings["showReasoning"] === true ? 'ON' : 'OFF'}\nUsage: /thought on|off`,
        };
    }
    if (sub !== 'on' && sub !== 'off') {
        return { ok: false, text: 'Usage: /thought on|off' };
    }

    const next = sub === 'on';
    const updateResult = await ctx.updateSettings({ showReasoning: next }) as SlashResult;
    if (updateResult?.ok === false) return updateResult;
    return { ok: true, text: `Gemini thought visibility: ${next ? 'ON' : 'OFF'}` };
}

export async function skillHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || 'list').toLowerCase();
    if (sub === 'list') {
        const skills = await safeCall(ctx.getSkills, null) as Array<{ enabled?: boolean }> | null;
        if (!Array.isArray(skills)) return { ok: false, text: t('cmd.skill.loadFail', {}, L) };
        const active = skills.filter(s => s.enabled).length;
        const ref = skills.filter(s => !s.enabled).length;
        return { ok: true, text: `🧰 Skills: ${active} active, ${ref} ref` };
    }
    if (sub === 'reset') {
        if (typeof ctx.resetSkills !== 'function') {
            return { ok: false, text: t('cmd.skill.resetUnavailable', {}, L) };
        }
        await ctx.resetSkills();
        return { ok: true, text: t('cmd.skill.resetDone', {}, L) };
    }
    return { ok: false, text: 'Usage: /skill [list|reset]' };
}

export async function employeeHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || '').toLowerCase();
    if (sub !== 'reset') {
        return { ok: false, text: 'Usage: /employee reset' };
    }
    if (typeof ctx.resetEmployees !== 'function') {
        return { ok: false, text: t('cmd.employee.resetUnavailable', {}, L) };
    }
    const result = await ctx.resetEmployees() as { seeded?: number } | undefined;
    const seeded = Number.isFinite(result?.seeded) ? result!.seeded : '?';
    return { ok: true, text: t('cmd.employee.resetDone', { count: seeded }, L) };
}

export async function clearHandler(_args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const iface = ctx.interface || 'cli';

    if (typeof ctx.clearSession === 'function') {
        await ctx.clearSession();
    }

    if (iface === 'telegram' || iface === 'discord') {
        return { ok: true, text: t('cmd.clear.remote', {}, L) };
    }
    return {
        ok: true,
        code: 'clear_screen',
        text: t('cmd.clear.done', {}, L),
    };
}

export async function resetHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    if ((args[0] || '').toLowerCase() !== 'confirm') {
        return {
            ok: false,
            text: t('cmd.reset.confirm', {}, L),
        };
    }
    const results = [];
    if (typeof ctx.resetSkills === 'function') {
        await ctx.resetSkills();
        results.push(t('cmd.reset.skills', {}, L));
    }
    if (typeof ctx.resetEmployees === 'function') {
        await ctx.resetEmployees();
        results.push(t('cmd.reset.employees', {}, L));
    }
    if (typeof ctx.syncMcp === 'function') {
        await ctx.syncMcp();
        results.push('MCP');
    }
    if (typeof ctx.resetSession === 'function') {
        await ctx.resetSession();
        results.push(t('cmd.reset.sessions', {}, L));
    }
    if (!results.length) {
        return { ok: false, text: t('cmd.reset.unavailable', {}, L) };
    }
    return { ok: true, text: t('cmd.reset.done', { items: results.join(', ') }, L) };
}

export async function versionHandler(_args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const status = await safeCall(ctx.getCliStatus, null) as Record<string, { available?: boolean; path?: string }> | null;
    const lines = [`cli-jaw v${(ctx as { version?: string }).version || 'unknown'}`];
    if (status && typeof status === 'object') {
        for (const key of DEFAULT_CLI_CHOICES) {
            if (!status[key]) continue;
            const entry = status[key]!;
            const icon = entry.available ? '✅' : '❌';
            lines.push(`${key}: ${icon}${entry.path ? ` ${entry.path}` : ''}`);
        }
    }
    return { ok: true, text: lines.join('\n') };
}

export async function mcpHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'sync') {
        const d = await ctx.syncMcp() as { results?: Record<string, unknown> };
        const keys = Object.keys(d?.results || {});
        return { ok: true, text: t('cmd.mcp.syncDone', { count: keys.length }, L) };
    }
    if (sub === 'install') {
        const d = await ctx.installMcp() as { results?: Record<string, unknown> };
        const keys = Object.keys(d?.results || {});
        return { ok: true, text: t('cmd.mcp.installDone', { count: keys.length }, L) };
    }
    const d = await ctx.getMcp() as { servers?: Record<string, unknown> };
    const names = Object.keys(d?.servers || {});
    return {
        ok: true,
        text: `MCP servers (${names.length}): ${names.join(', ') || '(none)'}\n/mcp sync\n/mcp install`,
    };
}

// Re-exports for backward compatibility
export { memoryHandler, browserHandler, promptHandler, quitHandler, fileHandler, steerHandler, forwardHandler, fallbackHandler, flushHandler, ideHandler, orchestrateHandler } from './handlers-runtime.js';
export { modelArgumentCompletions, cliArgumentCompletions, skillArgumentCompletions, employeeArgumentCompletions, browserArgumentCompletions, fallbackArgumentCompletions, flushArgumentCompletions } from './handlers-completions.js';
