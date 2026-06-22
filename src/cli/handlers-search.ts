import { buildSearchSteerPrompt } from '../workflows/search.js';
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
    if (iface === 'telegram' || iface === 'discord') return result;

    const { submitMessage } = await import('../orchestrator/gateway.js');
    submitMessage(result.steerPrompt!, { origin: iface as 'cli' | 'web' });
    const { steerPrompt: _stripped, ...rest } = result;
    return rest;
}
