#!/usr/bin/env node
// bin/commands/goal.ts — CLI: jaw goal [set|plan|refine|status|update|done|cancel|pause|resume|clear|reset|history]
import { loadSettings, getServerUrl } from '../../src/core/config.js';
import { cliFetch, getCliAuthToken } from '../../src/cli/api-auth.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';
import { errString, isConnRefused } from '../_http-client.js';
import { GOAL_PLAN_PENDING_OBJECTIVE } from '../../src/goal/types.js';

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw goal — Persistent goal lifecycle

  Usage: jaw goal <subcommand> [args...]

  Subcommands:
    set <objective>     Set a new goal (up to 10000 characters)
    plan [hint]         AI selects and executes a goal (hint is optional direction)
    refine <objective>  Replace a pending plan-mode objective with the finalized goal
    status              Show active goal
    update <summary>    Add a checkpoint  (add --evidence <note>[,<...>] to record verification)
    done [note]         Mark goal complete (add --force to skip the evidence gate)
    cancel [reason]     Cancel goal
    pause [reason]      Pause goal
                        AI/agent pause must add --agent --audit <independent-review-summary>
    resume              Resume paused goal
    clear               Clear active goal
    reset               Reset goal store
    history [limit]     Show goal history

  Examples:
    jaw goal plan                              # AI decides goal from context
    jaw goal plan "improve auth"               # AI uses hint as direction
    jaw goal refine "Implement auth redirects" # Finalize AI-selected goal objective
    jaw goal set "Implement keyboard shortcuts"
    jaw goal update "K0 done"
    jaw goal done "All phases complete"
    jaw goal status
`);

loadSettings();

const args = process.argv.slice(3);
const sub = (args[0] || 'status').toLowerCase();
const rest = args.slice(1).join(' ').trim();

function splitFlagValue(values: string[], flag: string): { before: string[]; value?: string | undefined; hasFlag: boolean } {
    const idx = values.indexOf(flag);
    if (idx < 0) return { before: values, hasFlag: false };
    return {
        before: values.slice(0, idx),
        value: values.slice(idx + 1).join(' ').trim() || undefined,
        hasFlag: true,
    };
}

function pauseGateLines(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    const gate = value as Record<string, unknown>;
    if (gate['armed'] !== true) return [];
    return [
        `Pause gate: pending (${String(gate['attempts'] ?? 0)}/${String(gate['requiredAttempts'] ?? 2)})`,
        `Pause gate action: ${String(gate['nextAction'] ?? 'Run a second audited agent pause or log a productive checkpoint.')}`,
    ];
}

const PORT = undefined;
const BASE = getServerUrl(PORT);
await getCliAuthToken(PORT);

try {
    if (sub === 'status' || sub === '--json') {
        const res = await cliFetch(`${BASE}/api/goal`);
        const body = await res.json() as Record<string, unknown>;
        if (!res.ok) { console.error((body['error'] as string) || `Failed: ${res.status}`); process.exit(1); }
        const goal = body['goal'] as Record<string, unknown> | null;
        if (!goal) { console.log('No active goal.'); process.exit(0); }
        if (sub === '--json') { console.log(JSON.stringify({ goal, pauseGate: body['pauseGate'] }, null, 2)); process.exit(0); }
        console.log(`Goal: ${goal['objective']}`);
        console.log(`Status: ${goal['status']}`);
        for (const line of pauseGateLines(body['pauseGate'])) console.log(line);
        if (goal['goalMode']) console.log(`Mode: ${goal['goalMode']}`);
        if (goal['planHint']) console.log(`Plan hint: ${goal['planHint']}`);
        console.log(`ID: ${goal['id']}`);
        console.log(`Created: ${goal['createdAt']}`);
        process.exit(0);
    }

    if (sub === 'history') {
        const limit = Number(rest) || 10;
        const res = await cliFetch(`${BASE}/api/goal/history?limit=${limit}`);
        const body = await res.json() as Record<string, unknown>;
        if (!res.ok) { console.error((body['error'] as string) || `Failed: ${res.status}`); process.exit(1); }
        const items = (body['goals'] ?? body['history']) as Array<Record<string, unknown>> | undefined;
        if (!items || items.length === 0) { console.log('No goal history.'); process.exit(0); }
        for (const g of items) {
            console.log(`[${g['status']}] ${g['objective']} (${g['id']})`);
        }
        process.exit(0);
    }

    if (sub === 'plan') {
        const hint = args.slice(1).join(' ').trim();
        const res = await cliFetch(`${BASE}/api/goal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'set',
                objective: GOAL_PLAN_PENDING_OBJECTIVE,
                goalMode: 'plan',
                replace: true,
                ...(hint ? { planHint: hint } : {}),
            }),
        });
        const body = await res.json() as Record<string, unknown>;
        if (!res.ok) { console.error((body['error'] as string) || `Failed: ${res.status}`); process.exit(1); }
        const goal = body['goal'] as Record<string, unknown>;
        console.log(`✅ Goal plan activated${hint ? `: ${hint}` : ''}\nID: ${goal?.['id']}\nMode: AI selects and executes goal`);
        process.exit(0);
    }

    const actionMap: Record<string, string> = {
        set: 'set', refine: 'refine-objective', done: 'done', cancel: 'cancel',
        update: 'update', pause: 'pause', resume: 'resume',
        clear: 'clear', reset: 'reset',
    };

    const action = actionMap[sub];
    if (!action) {
        console.error(`Unknown subcommand: ${sub}`);
        console.error('Use: set, plan, refine, status, update, done, cancel, pause, resume, clear, reset, history');
        process.exit(1);
    }

    const payload: Record<string, unknown> = { action };
    if (sub === 'set') {
        payload['objective'] = rest || undefined;
        payload['replace'] = true;
    }
    if (sub === 'refine') payload['objective'] = rest || undefined;
    if (sub === 'cancel') payload['reason'] = rest || undefined;
    if (sub === 'done') {
        payload['note'] = args.slice(1).filter(a => a !== '--force').join(' ').trim() || undefined;
        if (args.includes('--force')) payload['force'] = true;
    }
    if (sub === 'pause') {
        const agentRequested = args.includes('--agent');
        const pauseArgs = args.slice(1).filter(a => a !== '--agent');
        const audit = splitFlagValue(pauseArgs, '--audit');
        if (!agentRequested && !process.stdin.isTTY) {
            console.error('Non-interactive goal pause must use: cli-jaw goal pause --agent --audit "<independent-review-summary>". Plain `cli-jaw goal pause` is for manual interactive use.');
            process.exit(1);
        }
        payload['reason'] = audit.before.join(' ').trim() || undefined;
        if (agentRequested) payload['actor'] = 'agent';
        if (audit.value) payload['audit'] = audit.value;
    }
    if (sub === 'update') {
        const u = args.slice(1);
        const evIdx = u.indexOf('--evidence');
        if (evIdx >= 0) {
            payload['summary'] = u.slice(0, evIdx).join(' ').trim() || undefined;
            payload['evidence'] = u.slice(evIdx + 1).join(' ').split(',').map(s => s.trim()).filter(Boolean);
        } else {
            payload['summary'] = rest || undefined;
        }
    }

    const res = await cliFetch(`${BASE}/api/goal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) {
        console.error((body['error'] as string) || `Failed: ${res.status}`);
        process.exit(1);
    }

    const goal = body['goal'] as Record<string, unknown> | null;
    switch (sub) {
        case 'set': console.log(`✅ Goal set: ${goal?.['objective']}`); break;
        case 'refine': console.log(`✅ Goal refined: ${goal?.['objective']}`); break;
        case 'done': console.log(`✅ Goal completed: ${goal?.['objective']}`); break;
        case 'cancel': console.log(`✅ Goal cancelled: ${goal?.['objective']}`); break;
        case 'update': console.log(`✅ Checkpoint added`); break;
        case 'pause': console.log(`✅ Goal paused: ${goal?.['objective']}`); break;
        case 'resume': console.log(`✅ Goal resumed: ${goal?.['objective']}`); break;
        case 'clear': console.log('✅ Goal cleared'); break;
        case 'reset': console.log('✅ Goal store reset'); break;
    }
} catch (e) {
    if (isConnRefused(e)) {
        console.error(`Server not running. Start with: jaw serve`);
    } else {
        console.error(`Error: ${errString(e)}`);
    }
    process.exit(1);
}
