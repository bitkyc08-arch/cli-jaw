import { renderMarkdown, escapeHtml, sanitizeHtml, stripOrchestration } from '../render.js';
import { renderMermaidBlocks } from '../render.js';
import { generateId } from '../uuid.js';
import { state } from '../state.js';
import { getVirtualScroll, VS_THRESHOLD } from '../virtual-scroll.js';
import { activateWidgets } from '../diagram/iframe-renderer.js';
import { getAppName } from './appname.js';
import { getAgentAvatarMarkup, getUserAvatarMarkup } from './avatar.js';
import { hydrateElicitationBlocks } from './elicitation.js';
import { hydrateSearchResultsBlocks } from '../render/search-results.js';
import { hydrateComposeBlocks } from '../render/compose-block.js';
import { hydrateDataframeBlocks } from '../render/dataframe.js';
import { hydrateChartJsonBlocks } from '../render/chart-json.js';
import { hydrateLinkPreviewCards } from '../render/link-preview.js';
import { t } from './i18n.js';
import { renderMessageActionsHtml } from './message-actions.js';
import { API_BASE } from '../api.js';
import { normalizeAgentToolBlocks } from './process-block-dom.js';
import { scrollToBottom } from './chat-scroll.js';
import { registerVirtualScrollCallbacks } from './message-history.js';

function getAgentIcon(_cli?: string | null): string {
    return getAgentAvatarMarkup();
}

export function showSkeleton(): void {
    const container = document.getElementById('chatMessages');
    if (!container || container.querySelector('.skeleton-msg')) return;
    if (state.currentAgentDiv && state.currentAgentDiv.isConnected) return;
    hideEmptyState();
    const skel = document.createElement('div');
    skel.className = 'skeleton-msg';
    skel.innerHTML = '<div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div>';
    container.appendChild(skel);
    scrollToBottom();
}

export function removeSkeleton(): void {
    document.querySelectorAll('.skeleton-msg').forEach(el => el.remove());
}

export function hideEmptyState(): void {
    document.getElementById('emptyState')?.classList.remove('visible');
}

export function showEmptyState(): void {
    const container = document.getElementById('chatMessages');
    if (container && container.children.length === 0) {
        document.getElementById('emptyState')?.classList.add('visible');
    }
}

export function addSystemMsg(text: string, extraClass?: string, type?: string): void {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const vs = getVirtualScroll();
    hideEmptyState();
    const div = document.createElement('div');
    const typeClass = type ? ` msg-type-${type}` : '';
    div.className = 'msg msg-system' + typeClass + (extraClass ? ' ' + extraClass : '');
    div.innerHTML = sanitizeHtml(text);
    if (vs.active) {
        vs.appendLiveItem(div);
    } else {
        container.appendChild(div);
    }
    scrollToBottom();
}

export function formatUserPrompt(text: string): string {
    const multiMatch = text.match(/^\[(?:사용자가 파일 (\d+)개를 보냈습니다|User sent (\d+) files)\]/);
    if (multiMatch) {
        const count = multiMatch[1] || multiMatch[2];
        const userMsgMatch = text.match(/(?:사용자 메시지|User message): (.+)$/s);
        const userMsg = userMsgMatch ? ' ' + userMsgMatch[1].trim() : '';
        return `📎 [${count} files]${userMsg}`;
    }
    // ja/zh 변형이 빠지면 해당 로케일 사용자는 인라인 미리보기를 잃고 원문이
    // 그대로 노출된다. zh 는 전각 콜론(：)을 쓰므로 구분자를 일반화한다.
    const fileMatch = text.match(/^\[(?:사용자가 파일을 보냈습니다|사용자가 이미지를 보냈습니다|사용자가 동영상을 보냈습니다|User sent a file|User sent an image|User sent a video|ユーザーがファイルを送信しました|ユーザーが画像を送信しました|ユーザーが動画を送信しました|用户发送了文件|用户发送了图片|用户发送了视频)[:：]\s*([^\]]+)\]/);
    if (fileMatch) {
        const fullPath = fileMatch[1];
        const fileName = fullPath.split('/').pop() || fullPath;
        const voiceMatch = text.match(/🎤\s*(.{0,80})/);
        const voicePart = voiceMatch ? `${t('chat.voice.label')} ` : '';
        const userMsgMatch = text.match(/(?:사용자 메시지|User message): (.+)$/s);
        const userMsg = userMsgMatch ? ' ' + userMsgMatch[1].trim() : '';
        // Inline media rendering
        const ext = (fileName.split('.').pop() || '').toLowerCase();
        const mediaUrl = `${API_BASE}/media/${encodeURIComponent(fileName)}`;
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
            return `${voicePart}<img src="${mediaUrl}" alt="${fileName}" class="chat-inline-img" loading="lazy" />${userMsg ? `<br>${userMsg}` : ''}`;
        }
        if (['mp4', 'webm', 'mov', 'ogg'].includes(ext)) {
            return `${voicePart}<video src="${mediaUrl}" controls class="chat-inline-video" preload="metadata"></video>${userMsg ? `<br>${userMsg}` : ''}`;
        }
        return `${voicePart}📎 [${fileName}]${userMsg}`;
    }
    return text;
}

export function addMessage(role: string, text: string, cli?: string | null): HTMLDivElement {
    const container = document.getElementById('chatMessages');
    const vs = getVirtualScroll();
    hideEmptyState();
    removeSkeleton();
    const displayText = role === 'user' ? formatUserPrompt(text) : text;
    const rendered = renderMarkdown(displayText);
    const label = escapeHtml(role === 'user' ? t('msg.you') : getAppName());
    const div = document.createElement('div');
    const turnIndex = container ? container.querySelectorAll('.msg').length : null;
    const messageId = generateId();
    div.setAttribute('data-message-role', role);
    div.setAttribute('data-message-id', messageId);
    if (turnIndex !== null) div.setAttribute('data-turn-index', String(turnIndex));
    const port = Number(window.location.port);
    if (Number.isFinite(port) && port > 0) div.setAttribute('data-instance-id', `port:${port}`);
    const actions = renderMessageActionsHtml();
    if (role === 'agent') {
        div.className = 'msg msg-agent';
        div.innerHTML = `<div class="agent-icon" aria-hidden="true">${getAgentIcon(cli)}</div><div class="agent-body"><div class="msg-content">${rendered}</div>${actions}</div>`;
    } else {
        // Goal-continuation boundary rows stay .msg-user (the class is the
        // run-boundary signal for hasFollowingUserMessage) but get a modifier
        // class so they render as a slim marker, not a full user bubble.
        const isGoalBoundary = role === 'user' && cli === 'goal_continuation';
        div.className = `msg msg-${role}${isGoalBoundary ? ' msg-goal-boundary' : ''}`;
        div.innerHTML = `<div class="user-body"><div class="msg-label">${label}</div><div class="msg-content">${rendered}</div>${actions}</div><div class="user-icon" aria-hidden="true">${getUserAvatarMarkup()}</div>`;
    }
    const contentEl = div.querySelector('.msg-content');
    if (contentEl) contentEl.setAttribute('data-raw', stripOrchestration(text));
    const isStreamingPlaceholder = role === 'agent' && !text;
    if (vs.active && !isStreamingPlaceholder) {
        if (div.classList.contains('msg-agent')) normalizeAgentToolBlocks(div);
        vs.appendLiveItem(div);
    } else {
        container?.appendChild(div);
        activateWidgets(div);
        hydrateElicitationBlocks(div);
        hydrateSearchResultsBlocks(div);
        hydrateComposeBlocks(div);
        hydrateDataframeBlocks(div);
        hydrateChartJsonBlocks(div);
        hydrateLinkPreviewCards(div);
        if (!vs.active && !isStreamingPlaceholder && container) {
            const msgCount = container.querySelectorAll('.msg').length;
            if (msgCount >= VS_THRESHOLD) {
                registerVirtualScrollCallbacks(vs);
                container.querySelectorAll('.msg').forEach(el => {
                    if (el.classList.contains('msg-agent')) normalizeAgentToolBlocks(el as HTMLElement);
                    vs.addItem(generateId(), el.outerHTML);
                });
            }
        }
    }
    scrollToBottom(role === 'user');
    return div;
}
