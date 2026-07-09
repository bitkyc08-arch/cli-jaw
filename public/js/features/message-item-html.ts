import { escapeHtml, stripOrchestration } from '../render.js';
import { generateId } from '../uuid.js';
import { getAppName } from './appname.js';
import { getAgentAvatarMarkup, getUserAvatarMarkup } from './avatar.js';
import { t } from './i18n.js';
import { messageSourceAttributes, renderMessageActionsHtml } from './message-actions.js';
import { formatUserPrompt } from './chat-messages.js';
import { sanitizedToolLogJson, type MessageItem } from './process-log-adapter.js';
import type { VirtualItem } from '../virtual-scroll.js';

function getAgentIcon(_cli?: string | null): string {
    return getAgentAvatarMarkup();
}

export function buildLazyVirtualMessageItem(m: MessageItem, index: number): VirtualItem {
    const role = m.role === 'assistant' ? 'agent' : m.role;
    const messageId = String(m.id ?? generateId());
    const sourceAttrs = messageSourceAttributes({ role, messageId, turnIndex: index });
    const rawContent = stripOrchestration(
        role === 'user' ? formatUserPrompt(m.content) : m.content,
    );
    const label = escapeHtml(role === 'user' ? t('msg.you') : getAppName());
    const sanitizedToolLog = m.role === 'assistant' && m.tool_log
        ? sanitizedToolLogJson(m.tool_log)
        : null;
    const rawToolLog = sanitizedToolLog ? escapeHtml(sanitizedToolLog) : '';
    const toolAttr = rawToolLog ? ` data-tool-log="${rawToolLog}"` : '';
    const contentHtml = `<div class="msg-content lazy-pending" data-raw="${escapeHtml(rawContent)}"></div>`;
    const actions = renderMessageActionsHtml();
    // Keep .msg-user for boundary semantics; modifier slims the visual (see chat-messages.ts).
    const goalBoundaryClass = role === 'user' && m.cli === 'goal_continuation' ? ' msg-goal-boundary' : '';
    const html = role === 'agent'
        ? `<div class="msg msg-agent" ${sourceAttrs}><div class="agent-icon" aria-hidden="true">${getAgentIcon(m.cli)}</div><div class="agent-body"${toolAttr}>${contentHtml}${actions}</div></div>`
        : `<div class="msg msg-${role}${goalBoundaryClass}" ${sourceAttrs}><div class="user-body"><div class="msg-label">${label}</div>${contentHtml}${actions}</div><div class="user-icon" aria-hidden="true">${getUserAvatarMarkup()}</div></div>`;
    return { id: generateId(), html, height: 80, rehydratesProcessDetails: Boolean(rawToolLog) };
}
