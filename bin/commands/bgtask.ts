#!/usr/bin/env node
// bin/commands/bgtask.ts — CLI: jaw bgtask [add|list|show|cancel]
// Server-owned background tasks: register long-running work, end the boss
// turn, and let the jaw server re-invoke the boss when the work completes.
import { loadSettings, getServerUrl } from '../../src/core/config.js';
import { cliFetch } from '../../src/cli/api-auth.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw bgtask — Server-owned background tasks (background runtime hook)

  Usage: jaw bgtask <subcommand> [args...]

  Subcommands:
    add --preset web-ai --session <sessionId> [--prompt <template>] [--deadline <ISO>] [--stall-after-ms <ms>]
                          Watch a native web-ai session; boss is re-invoked on completion
    add --cmd '<json-argv>' [--kind <kind>] [--completion exit|'<json>'] [--prompt <template>] [--stall-after-ms <ms>]
                          Generic child task, e.g. --cmd '["gh","run","watch","123"]'
    list [--status running|complete|failed|cancelled|orphaned]
    show <taskId>
    cancel <taskId>

  Prompt template placeholders: {{result}} {{taskId}} {{status}}

  Examples:
    jaw bgtask add --preset web-ai --session "$SID" --prompt "Summarize: {{result}}"
    jaw bgtask add --cmd '["gh","run","watch","123","--exit-status"]' --kind ci --prompt "CI done: {{result}}"
    jaw bgtask list --status running
`);

loadSettings();
const BASE = getServerUrl();
const args = process.argv.slice(3);
const sub = (args[0] || 'list').toLowerCase();

function flagValue(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    if (idx < 0 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
}

function printTask(task: Record<string, unknown>): void {
    const spec = (task['spec'] ?? {}) as Record<string, unknown>;
    const completion = (spec['completion'] ?? {}) as Record<string, unknown>;
    console.log(`${task['id']}  [${task['status']}${task['runnerActive'] ? ' • runner active' : ''}]  kind=${task['kind']}  completion=${completion['type'] ?? '?'}`);
    if (task['createdAt']) console.log(`  created: ${task['createdAt']}${task['completedAt'] ? `  completed: ${task['completedAt']}` : ''}`);
    if (task['notifiedAt']) console.log(`  notified: ${task['notifiedAt']}`);
}

async function readBody(res: { json(): Promise<unknown>; ok: boolean; status: number }): Promise<Record<string, unknown>> {
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) {
        console.error((body['error'] as string) || `Failed: ${res.status}`);
        if (body['existingId']) console.error(`existing task: ${body['existingId']}`);
        process.exit(1);
    }
    return body;
}

if (sub === 'list') {
    const status = flagValue('--status');
    const res = await cliFetch(`${BASE}/api/bgtask${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    const body = await readBody(res);
    const tasks = (body['tasks'] ?? []) as Array<Record<string, unknown>>;
    if (tasks.length === 0) {
        console.log('No background tasks.');
        process.exit(0);
    }
    for (const t of tasks) printTask(t);
    process.exit(0);
}

if (sub === 'show') {
    const id = args[1];
    if (!id) { console.error('Usage: jaw bgtask show <taskId>'); process.exit(1); }
    const res = await cliFetch(`${BASE}/api/bgtask/${encodeURIComponent(id)}`);
    const body = await readBody(res);
    console.log(JSON.stringify(body['task'], null, 2));
    process.exit(0);
}

if (sub === 'cancel') {
    const id = args[1];
    if (!id) { console.error('Usage: jaw bgtask cancel <taskId>'); process.exit(1); }
    const res = await cliFetch(`${BASE}/api/bgtask/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const body = await readBody(res);
    console.log(body['cancelled'] ? `✅ cancelled ${id}` : `task ${id} was not running (no-op)`);
    process.exit(0);
}

if (sub === 'add') {
    const preset = flagValue('--preset');
    const payload: Record<string, unknown> = {};
    const prompt = flagValue('--prompt');
    const deadline = flagValue('--deadline');
    const stallRaw = flagValue('--stall-after-ms');
    const stallAfterMs = stallRaw ? Number(stallRaw) : undefined;

    if (preset === 'web-ai') {
        const sessionId = flagValue('--session');
        if (!sessionId) { console.error('Usage: jaw bgtask add --preset web-ai --session <sessionId>'); process.exit(1); }
        payload['preset'] = 'web-ai';
        payload['sessionId'] = sessionId;
        if (prompt) payload['prompt'] = prompt;
        if (deadline) payload['deadlineAt'] = deadline;
        if (stallAfterMs && stallAfterMs > 0) payload['stallAfterMs'] = stallAfterMs;
    } else if (preset) {
        console.error(`Unknown preset: ${preset}`);
        process.exit(1);
    } else {
        const cmdRaw = flagValue('--cmd');
        if (!cmdRaw || !prompt) {
            console.error('Usage: jaw bgtask add --cmd \'<json-argv>\' --prompt <template> [--kind <kind>] [--completion exit|\'<json>\'] [--deadline <ISO>]');
            process.exit(1);
        }
        let command: unknown;
        try {
            command = JSON.parse(cmdRaw);
        } catch {
            console.error('--cmd must be a JSON argv array, e.g. \'["gh","run","watch","123"]\'');
            process.exit(1);
        }
        const completionRaw = flagValue('--completion') ?? 'exit';
        const completion = completionRaw === 'exit' ? { type: 'exit' } : JSON.parse(completionRaw);
        payload['kind'] = flagValue('--kind') ?? 'shell';
        payload['spec'] = {
            command,
            completion,
            promptTemplate: prompt,
            ...(deadline ? { deadlineAt: deadline } : {}),
            ...(stallAfterMs && stallAfterMs > 0 ? { stallAfterMs } : {}),
        };
    }

    const res = await cliFetch(`${BASE}/api/bgtask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const body = await readBody(res);
    const task = body['task'] as Record<string, unknown>;
    console.log(`✅ bgtask registered: ${task['id']}`);
    console.log('   The server now owns this work — you can end the turn; the boss will be re-invoked on completion.');
    for (const w of (body['warnings'] ?? []) as string[]) console.log(`⚠️  ${w}`);
    process.exit(0);
}

console.error(`Unknown bgtask command: ${sub}`);
process.exit(1);
