// ─── Runtime Handlers ─────────────────────────────────
// Extracted from handlers.ts for 500-line compliance.

import { CLI_KEYS, buildModelChoicesByCli } from './registry.js';
import { t } from '../core/i18n.js';
import { detectCli, settings } from '../core/config.js';
import type { CliCommandContext } from './command-context.js';
import type { SlashResult } from './types.js';

const MODEL_CHOICES_BY_CLI = buildModelChoicesByCli();

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

export async function memoryHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const sub = String(args[0] || '').toLowerCase();
    if (sub === 'status') {
        const status = await ctx.getMemoryStatus?.() as Record<string, unknown> | undefined;
        const routing = status?.["routing"] as { searchRead?: string; save?: string } | undefined;
        const lines = [
            `🧠 Memory`,
            `State: ${status?.["state"] || '-'}`,
            `Storage: ${status?.["storageRoot"] || '-'}`,
            `Search/Read: ${routing?.searchRead || 'basic'}`,
            `Save: ${routing?.save || 'basic'}`,
            `Indexed files: ${status?.["indexedFiles"] || 0}`,
            `Indexed chunks: ${status?.["indexedChunks"] || 0}`,
        ];
        return { ok: true, text: lines.join('\n') };
    }
    if (sub === 'bootstrap') {
        const result = await ctx.bootstrapMemory?.({
            importCore: true,
            importMarkdown: true,
            importKv: true,
            importClaudeSession: true,
        }) as { root?: string; counts?: Record<string, number> } | undefined;
        return {
            ok: true,
            text: [
                '🧠 Memory bootstrap completed',
                `Root: ${result?.root || '-'}`,
                `Imported core=${result?.counts?.["core"] || 0}, markdown=${result?.counts?.["markdown"] || 0}, kv=${result?.counts?.["kv"] || 0}, claude=${result?.counts?.["claude"] || 0}`,
            ].join('\n'),
        };
    }
    if (sub === 'reindex') {
        const result = await ctx.reindexMemory?.() as { totalFiles?: number; totalChunks?: number } | undefined;
        return {
            ok: true,
            text: [
                '🧠 Memory reindex completed',
                `Files: ${result?.totalFiles || 0}`,
                `Chunks: ${result?.totalChunks || 0}`,
            ].join('\n'),
        };
    }
    if (sub === 'flush') {
        try {
            const { triggerMemoryFlush } = await import('../agent/memory-flush-controller.js');
            await triggerMemoryFlush();
            return { ok: true, text: '🧠 Memory flush triggered.' };
        } catch (err) {
            return { ok: false, text: `❌ Flush failed: ${(err as Error).message}` };
        }
    }
    if (sub === 'adv') {
        const action = String(args[1] || 'status').toLowerCase();
        if (action === 'on') {
            const status = await ctx.getMemoryStatus?.() as Record<string, unknown> | undefined;
            return {
                ok: true,
                text: `🧠 Memory is integrated by default.\nState: ${status?.["state"] || 'not_initialized'}`,
            };
        }
        if (action === 'off') {
            return { ok: true, text: '🧠 Memory can no longer be turned off as a separate mode.' };
        }
        if (action === 'init') {
            const created = await ctx.initMemoryRuntime?.() as { root?: string } | undefined;
            const status = await ctx.getMemoryStatus?.() as Record<string, unknown> | undefined;
            return {
                ok: true,
                text: `🧠 Memory initialized\nRoot: ${created?.root || status?.["storageRoot"] || '-'}\nState: ${status?.["state"] || 'configured'}`,
            };
        }
        if (action === 'bootstrap') {
            const result = await ctx.bootstrapMemory?.({
                importCore: true,
                importMarkdown: true,
                importKv: true,
                importClaudeSession: true,
            }) as { root?: string; counts?: Record<string, number> } | undefined;
            const status = await ctx.getMemoryStatus?.() as Record<string, unknown> | undefined;
            return {
                ok: true,
                text: [
                    '🧠 Memory bootstrap completed',
                    `Root: ${result?.root || status?.["storageRoot"] || '-'}`,
                    `Imported core=${result?.counts?.["core"] || 0}, markdown=${result?.counts?.["markdown"] || 0}, kv=${result?.counts?.["kv"] || 0}, claude=${result?.counts?.["claude"] || 0}`,
                    `Import status: ${status?.["importStatus"] || '-'}`,
                ].join('\n'),
            };
        }
        if (action === 'reindex') {
            const result = await ctx.reindexMemory?.() as { totalFiles?: number; totalChunks?: number } | undefined;
            const status = await ctx.getMemoryStatus?.() as Record<string, unknown> | undefined;
            return {
                ok: true,
                text: [
                    '🧠 Memory reindex completed',
                    `Files: ${result?.totalFiles || status?.["indexedFiles"] || 0}`,
                    `Chunks: ${result?.totalChunks || status?.["indexedChunks"] || 0}`,
                    `State: ${status?.["indexState"] || '-'}`,
                ].join('\n'),
            };
        }
        const status = await ctx.getMemoryStatus?.() as Record<string, unknown> | undefined;
        const routing = status?.["routing"] as { searchRead?: string; save?: string } | undefined;
        const importedCounts = status?.["importedCounts"] as Record<string, number> | undefined;
        const lines = [
            `🧠 Memory: ${status?.["enabled"] ? 'ON' : 'OFF'}`,
            `State: ${status?.["state"] || '-'}`,
            `Storage: ${status?.["storageRoot"] || '-'}`,
            `Routing(search/read): ${routing?.searchRead || 'basic'}`,
            `Routing(save): ${routing?.save || 'basic'}`,
            `Indexed files: ${status?.["indexedFiles"] || 0}`,
            `Indexed chunks: ${status?.["indexedChunks"] || 0}`,
            `Imported core/markdown/kv/claude: ${importedCounts?.["core"] || 0}/${importedCounts?.["markdown"] || 0}/${importedCounts?.["kv"] || 0}/${importedCounts?.["claude"] || 0}`,
        ];
        return { ok: true, text: lines.join('\n') };
    }
    if (!args.length || (args.length === 1 && args[0]!.toLowerCase() === 'list')) {
        const files = await ctx.listMemory() as Array<{ path: string; size: number }> | undefined;
        if (!files?.length) return { ok: true, text: t('cmd.memory.empty', {}, L) };
        const lines = files.slice(0, 20).map((f) => `- ${f.path} (${f.size}b)`);
        return { ok: true, text: `🧠 memory files (${files.length})\n${lines.join('\n')}` };
    }
    const query = args.join(' ').trim();
    const result = await ctx.searchMemory(query);
    const text = String(result || '(no results)');
    const MAX = 3000;
    return { ok: true, text: text.length > MAX ? text.slice(0, MAX) + '\n...(truncated)' : text };
}

export async function browserHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'tabs') {
        const d = await ctx.getBrowserTabs() as { tabs?: Array<{ title?: string; url?: string }> };
        const tabs = d?.tabs || [];
        if (!tabs.length) return { ok: true, text: t('cmd.browser.noTabs', {}, L) };
        const lines = tabs.slice(0, 10).map((tab, i: number) => `${i + 1}. ${tab.title || '(untitled)'}\n   ${tab.url || ''}`);
        return { ok: true, text: lines.join('\n') };
    }
    if (sub !== 'status') return { ok: false, text: 'Usage: /browser [status|tabs]' };
    const d = await ctx.getBrowserStatus() as unknown as { running?: boolean; tabs?: unknown[]; tabCount?: number; cdpUrl?: string };
    const running = d?.running ? 'running' : 'stopped';
    const tabCount = d?.tabs?.length ?? d?.tabCount ?? '-';
    return { ok: true, text: `🌐 Browser: ${running}\nTabs: ${tabCount}\nCDP: ${d?.cdpUrl || '-'}` };
}

export async function promptHandler(_args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const d = await ctx.getPrompt() as { content?: string };
    const content = d?.content || '';
    if (!content.trim()) return { ok: true, text: '(empty prompt)' };
    const lines = content.trim().split('\n');
    const preview = lines.slice(0, 20).join('\n');
    const suffix = lines.length > 20 ? '\n...(truncated)' : '';
    return { ok: true, text: `${preview}${suffix}` };
}

export async function quitHandler(): Promise<SlashResult> {
    return { ok: true, code: 'exit', text: 'Bye!' };
}

export async function fileHandler(): Promise<SlashResult> {
    return { ok: false, text: 'Usage: /file <path> [caption]' };
}

export async function steerHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const prompt = args.join(' ').trim();
    if (!prompt) {
        return { ok: false, type: 'error', text: t('cmd.steer.noPrompt', {}, L) };
    }
    const { isAgentBusy, killActiveAgent, waitForProcessEnd } = await import('../agent/spawn.js');
    if (!isAgentBusy()) {
        return { ok: false, type: 'error', text: t('cmd.steer.noAgent', {}, L) };
    }

    // Kill running agent (or cancel retry timer) and wait for clean exit
    killActiveAgent('steer');
    await waitForProcessEnd(3000);

    // Remote interfaces: clear stale session before re-orchestrate
    const iface = ctx.interface || 'cli';
    if (iface === 'telegram' || iface === 'discord') {
        if (typeof ctx.clearSession === 'function') {
            await ctx.clearSession();
        }
        return { ok: true, type: 'steer', text: t('cmd.steer.started', {}, L), steerPrompt: prompt };
    }

    // Web/CLI: fire orchestration directly via submitMessage
    const { submitMessage } = await import('../orchestrator/gateway.js');
    submitMessage(prompt, { origin: iface as 'cli' | 'web' | 'telegram' | 'discord' });
    return { ok: true, type: 'success', text: t('cmd.steer.started', {}, L) };
}

export async function forwardHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const iface = ctx.interface || 'cli';
    const remote = iface === 'discord' ? 'discord'
        : iface === 'telegram' ? 'telegram'
        : null;
    // Determine which channel's forwardAll to modify
    const settings = await safeCall(ctx.getSettings, null) as Record<string, unknown> | null;
    const channelKey = remote || ((settings?.["channel"] as string | undefined) || 'telegram');
    const arg = args[0]?.toLowerCase();
    if (arg === 'on' || arg === 'off') {
        const val = arg === 'on';
        const patch = { [channelKey]: { forwardAll: val } };
        const r = await ctx.updateSettings(patch) as SlashResult;
        if (!r?.ok) return { ok: false, text: r?.text || 'Failed' };
        const label = channelKey === 'discord' ? 'Discord' : 'Telegram';
        return { text: `📡 ${label} forwarding: ${val ? 'ON (all)' : 'OFF (channel only)'}` };
    }
    const dc = settings?.["discord"] as { forwardAll?: boolean } | undefined;
    const tg = settings?.["telegram"] as { forwardAll?: boolean } | undefined;
    const current = channelKey === 'discord'
        ? dc?.forwardAll !== false
        : tg?.forwardAll !== false;
    const label = channelKey === 'discord' ? 'Discord' : 'Telegram';
    return { text: `📡 ${label} forwarding: ${current ? 'ON (all)' : 'OFF (channel only)'}\nUsage: /forward on|off` };
}

export async function fallbackHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const settings = await safeCall(ctx.getSettings, null) as Record<string, unknown> | null;
    if (!settings) return { ok: false, text: t('cmd.settingsLoadFail', {}, L) };
    const available = Object.keys((settings["perCli"] as Record<string, unknown> | undefined) || {});

    if (!args.length) {
        const fb = (settings["fallbackOrder"] as string[] | undefined) || [];
        return {
            ok: true, type: 'info',
            text: fb.length
                ? `⚡ Fallback: ${fb.join(' → ')}`
                : t('cmd.fallback.inactive', { available: available.join(', ') }, L),
        };
    }

    if (args[0] === 'off' || args[0] === 'none') {
        const r = await ctx.updateSettings({ fallbackOrder: [] }) as SlashResult;
        if (r?.ok === false) return r;
        return { ok: true, text: t('cmd.fallback.off', {}, L) };
    }

    const order = args.filter((a) => available.includes(a.toLowerCase())).map((a) => a.toLowerCase());
    if (!order.length) {
        return { ok: false, text: t('cmd.fallback.invalidCli', { available: available.join(', ') }, L) };
    }

    const r = await ctx.updateSettings({ fallbackOrder: order }) as SlashResult;
    if (r?.ok === false) return r;
    return { ok: true, text: t('cmd.fallback.set', { order: order.join(' → ') }, L) };
}

export async function flushHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const settings = await safeCall(ctx.getSettings, null) as Record<string, unknown> | null;
    if (!settings) return { ok: false, text: t('cmd.settingsLoadFail', {}, L) };

    const activeCli = (settings["cli"] as string | undefined) || 'claude';
    const memSettings = settings["memory"] as { cli?: string; model?: string } | undefined;
    const perCli = settings["perCli"] as Record<string, { model?: string }> | undefined;
    const currentFlushCli = memSettings?.cli || activeCli;
    const currentFlushModel = memSettings?.model
        || perCli?.[currentFlushCli]?.model || 'default';

    if (!args.length) {
        const isDefault = !memSettings?.cli && !memSettings?.model;
        const suffix = isDefault ? ` (active ${activeCli} 사용)` : '';
        return { ok: true, text: t('cmd.flush.current', { cli: currentFlushCli, model: currentFlushModel }, L) + suffix };
    }

    const first = args[0]!.toLowerCase();

    // /flush off|reset
    if (first === 'off' || first === 'reset') {
        const mem = { ...(memSettings || {}), cli: '', model: '' };
        const r = await ctx.updateSettings({ memory: mem }) as SlashResult;
        if (r?.ok === false) return r;
        return { ok: true, text: t('cmd.flush.reset', {}, L) };
    }

    const cliKeys = [...CLI_KEYS] as readonly string[];
    let newCli: string;
    let newModel: string;

    if (cliKeys.includes(first)) {
        // /flush <cli> [model]
        newCli = first;
        newModel = args.slice(1).join(' ').trim() || 'default';
    } else {
        // /flush <model> — auto-detect CLI from registry
        const modelName = args.join(' ').trim();
        const modelKey = modelName.toLowerCase();

        // Hints for inferring the claude CLI from a bare model name
        const LEGACY_MODEL_CLI_HINTS: Record<string, string> = {
            // New short aliases (canonical)
            'opus': 'claude',
            'sonnet': 'claude',
            'sonnet[1m]': 'claude',
            'haiku': 'claude',
            // Legacy full IDs (preserved for backward compat)
            'claude-sonnet-4-6': 'claude',
            'claude-opus-4-6': 'claude',
            'claude-sonnet-4-6[1m]': 'claude',
            'claude-opus-4-6[1m]': 'claude',
            'claude-haiku-4-5-20251001': 'claude',
        };

        const hintedCli = LEGACY_MODEL_CLI_HINTS[modelName];
        if (hintedCli) {
            newCli = hintedCli;
            newModel = modelName;
        } else {
            const matchedClis: string[] = [];
            for (const [cli, models] of Object.entries(MODEL_CHOICES_BY_CLI)) {
                if ((models as string[]).some(m => m.toLowerCase() === modelKey)) {
                    matchedClis.push(cli);
                }
            }

            // Filter by available CLIs
            const availableClis = matchedClis.filter(c => detectCli(c).available);

            if (availableClis.length > 0) {
                newCli = availableClis[0]!;
                newModel = modelName;
            } else if (matchedClis.length > 0) {
                return {
                    ok: false,
                    text: t('cmd.flush.cliUnavailable', { cli: matchedClis.join(', '), model: modelName }, L),
                };
            } else {
                newCli = currentFlushCli;
                newModel = modelName;
            }
        }
    }

    // Validate target CLI is available
    if (!detectCli(newCli).available) {
        return {
            ok: false,
            text: t('cmd.flush.cliUnavailable', { cli: newCli, model: newModel }, L),
        };
    }

    const mem = { ...(memSettings || {}), cli: newCli, model: newModel };
    const r = await ctx.updateSettings({ memory: mem }) as SlashResult;
    if (r?.ok === false) return r;
    return { ok: true, text: t('cmd.flush.changed', { cli: newCli, model: newModel }, L) };
}

// ─── IDE Handler ─────────────────────────────────────

export async function ideHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'pop') return { ok: true, code: 'ide_pop_toggle', text: t('cmd.ide.popToggled', {}, L) };
    if (sub === 'on') return { ok: true, code: 'ide_on', text: t('cmd.ide.toggled', {}, L) };
    if (sub === 'off') return { ok: true, code: 'ide_off', text: t('cmd.ide.toggled', {}, L) };
    if (sub === '') return { ok: true, code: 'ide_toggle', text: t('cmd.ide.toggled', {}, L) };
    return { ok: false, text: t('cmd.ide.usage', {}, L) };
}

export async function orchestrateHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const { getState, setState, resetState, canTransition, getStatePrompt, getCtx } = await import('../orchestrator/state-machine.js');
    const { resolveOrcScope } = await import('../orchestrator/scope.js');
    type OrcStateName = 'IDLE' | 'P' | 'A' | 'B' | 'C' | 'D';

    // Phase 58: --force overrides audit/verification gates by setting userApproved.
    const force = args.includes('--force');
    const positional = args.filter(a => !a.startsWith('--'));
    const target = (positional[0] || 'P').toUpperCase();

    const origin = ctx?.interface || 'web';
    const scope = resolveOrcScope({ origin, workingDir: settings["workingDir"] || null });

    if (target === 'STATUS') {
        const current = getState(scope);
        const currentCtx = getCtx(scope);
        return {
            ok: true,
            text: [
                `State: ${current}`,
                `Scope: ${scope}`,
                `Audit: ${currentCtx?.auditStatus || 'none'}`,
                `Verification: ${currentCtx?.verificationStatus || 'none'}`,
                `User approved: ${currentCtx?.userApproved ? 'yes' : 'no'}`,
                `Plan: ${currentCtx?.plan ? 'present' : 'none'}`,
                `Worklog: ${currentCtx?.worklogPath || 'none'}`,
            ].join('\n'),
        };
    }

    if (target === 'RESET') {
        resetState(scope);
        return { ok: true, text: '✅ State → IDLE (reset)' };
    }

    const valid: OrcStateName[] = ['P', 'A', 'B', 'C', 'D'];
    if (!valid.includes(target as OrcStateName)) {
        return { ok: false, text: `Invalid state: ${target}. Must be one of: P, A, B, C, D, status, reset` };
    }

    const current = getState(scope);
    const t = target as OrcStateName;
    const currentCtx = getCtx(scope);
    // Phase 58/59: User-issued slash transitions are explicit approval for gate checks.
    const userInitiated = true;
    const hasExplicitApproval = force || userInitiated;
    const gateCtx = hasExplicitApproval && currentCtx ? { ...currentCtx, userApproved: true } : currentCtx;
    if (hasExplicitApproval && currentCtx) {
        setState(current, gateCtx, scope);
    }
    const gate = canTransition(current, t, gateCtx);
    if (!gate.ok) {
        return { ok: false, text: `Cannot transition: ${gate.reason}\nCurrent server state: ${current}` };
    }

    if (t === 'D') {
        setState(t, undefined, scope, 'Done');
        resetState(scope);
        return { ok: true, text: '✅ State → D (Done) → IDLE' };
    }

    if (t === 'P') {
        setState(t, { originalPrompt: '', workingDir: settings["workingDir"] || null, plan: null, workerResults: [], origin }, scope, 'P');
    } else {
        setState(t, undefined, scope, t);
    }
    const statePrompt = getStatePrompt(t);
    const summary = statePrompt.split('\n')[0] || '';
    return { ok: true, text: `✅ State → ${getState(scope)}${summary ? `\n${summary}` : ''}` };
}
