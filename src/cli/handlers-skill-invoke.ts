// ─── Skill Slash Command Handler ──────────────────────
// Handles /skill:<id> execution — injects SKILL.md as steerPrompt.

import { getSkillCommandsCache } from '../core/skill-cache.js';
import type { CliCommandContext } from './command-context.js';
import type { SlashResult } from './types.js';

export async function executeSkillCommand(
    skillId: string,
    args: string[],
    ctx: CliCommandContext,
): Promise<SlashResult> {
    const skill = getSkillCommandsCache().find(s => s.id === skillId);
    if (!skill) {
        return { ok: false, type: 'error', text: `Skill not found: ${skillId}` };
    }
    const userRequest = args.join(' ').trim();
    const steerPrompt = userRequest
        ? `${skill.content}\n\n---\nUser request: ${userRequest}`
        : skill.content;
    const result: SlashResult = {
        ok: true,
        type: 'info',
        text: `Skill invoked: ${skill.name}${userRequest ? ` — ${userRequest}` : ''}`,
        steerPrompt,
    };
    if (userRequest) result.originalText = userRequest;
    const iface = ctx.interface || 'web';
    if (iface !== 'telegram' && iface !== 'discord') {
        const { submitMessage } = await import('../orchestrator/gateway.js');
        submitMessage(steerPrompt, { origin: iface as 'cli' | 'web' });
        const { steerPrompt: _stripped, ...rest } = result;
        return rest;
    }
    return result;
}
