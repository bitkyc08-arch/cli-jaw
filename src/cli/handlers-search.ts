import { buildSearchSteerPrompt } from '../workflows/search.js';
import { sessionScopeMeta } from './session-scope-meta.js';
import type { CliCommandContext } from './command-context.js';
import type { SlashResult } from './types.js';

function joinArgs(args: string[]): string {
    return args.join(' ').trim();
}

function blocked(text: string, code = 'workflow_not_ready'): SlashResult {
    return { ok: false, type: 'error', code, text };
}

export async function searchWorkflowHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const query = joinArgs(args);
    if (!query) {
        return blocked('Usage: /search <query>', 'missing_search_query');
    }

    const result: SlashResult = {
        ok: true,
        type: 'info',
        text: `Search started: ${query}`,
        originalText: query,
        steerPrompt: buildSearchSteerPrompt({ query }),
    };

    const iface = ctx.interface || 'web';
    if (iface === 'telegram' || iface === 'discord' || iface === 'slack') return result;

    const { submitMessage } = await import('../orchestrator/gateway.js');
    // Carry the tab's session through. Without it the message lands in the
    // tab's chat session while the queue and PABCD scope fall back to
    // 'default', so the turn queues behind unrelated work and runs outside
    // the session's own lane.
    submitMessage(result.steerPrompt!, { origin: iface as 'cli' | 'web', ...sessionScopeMeta() });
    const { steerPrompt: _stripped, ...rest } = result;
    return rest;
}
