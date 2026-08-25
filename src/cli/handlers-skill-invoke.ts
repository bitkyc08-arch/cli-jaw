// ─── Skill Slash Command Handler ──────────────────────
import { sessionScopeMeta } from './session-scope-meta.js';
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
    if (iface !== 'telegram' && iface !== 'discord' && iface !== 'slack') {
        const { submitMessage } = await import('../orchestrator/gateway.js');
        // Carry the tab's session through. Without it the message lands in the
        // tab's chat session while the queue and PABCD scope fall back to
        // 'default', so the turn queues behind unrelated work and runs outside
        // the session's own lane.
        submitMessage(steerPrompt, { origin: iface as 'cli' | 'web', ...sessionScopeMeta() });
        const { steerPrompt: _stripped, ...rest } = result;
        return rest;
    }
    return result;
}
