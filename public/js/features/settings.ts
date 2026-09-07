// settings.ts — barrel re-export (preserves all import paths)
export { loadSettings, updateSettings, setPerm, onCliChange, saveActiveCliSettings, onFlushCliChange, loadFlushAgentSidebar } from './settings-core.js';
export { setTelegram, setForwardAll, setTelegramMentionOnly, saveTelegramSettings } from './settings-telegram.js';
export { setDiscord, setDiscordForwardAll, setDiscordAllowBots, setDiscordMentionOnly, saveDiscordSettings } from './settings-discord.js';
export { setSlack, setSlackForwardAll, setSlackAllowBots, setSlackMentionOnly, setSlackReplyInThread, saveSlackSettings, initSlackSetupGuide } from './settings-slack.js';
export { setActiveChannel, loadFallbackOrder, saveFallbackOrder } from './settings-channel.js';
export { loadMcpServers, syncMcpServers, installMcpGlobal, openMcpModal, initMcpModal } from './settings-mcp.js';
export { loadCliStatus, scheduleCliStatusRefresh, setCliStatusInterval } from './settings-cli-status.js';
export { initCliStatusToggle, initCliStatusPreviewHooks, isCliStatusExpanded, expandCliStatus, isEmbeddedPreviewFrame } from './settings-cli-status.js';
export { initSttSettings } from './settings-stt.js';
export { openPromptModal, closePromptModal, savePromptFromModal, openTemplateModal, saveTemplateFromModal, closeTemplateModal, templateGoBack, toggleDevMode } from './settings-templates.js';

/** Keep the header and iframe mounted so theme, drafts and event handlers survive. */
export function toggleSettingsPage(open = document.body.dataset['settingsOpen'] !== 'true'): void {
    const page = document.getElementById('settingsPage');
    const chat = document.querySelector<HTMLElement>('.chat-area');
    if (!page || !chat) return;
    if (!open) {
        const frame = page.querySelector<HTMLIFrameElement>('iframe');
        frame?.contentWindow?.postMessage({ type: 'settings:request-back' }, window.location.origin);
        return;
    }
    const header = chat.querySelector<HTMLElement>('.chat-header');
    if (header) page.prepend(header);
    document.body.dataset['settingsOpen'] = 'true';
    chat.hidden = true;
    chat.inert = true;
    page.hidden = false;
    document.getElementById('btnSettings')?.setAttribute('aria-pressed', 'true');
    page.querySelector<HTMLIFrameElement>('iframe')?.focus();
}

function closeSettingsPage(): void {
    const page = document.getElementById('settingsPage');
    const chat = document.querySelector<HTMLElement>('.chat-area');
    if (!page || !chat) return;
    const header = page.querySelector<HTMLElement>('.chat-header');
    if (header) chat.prepend(header);
    delete document.body.dataset['settingsOpen'];
    chat.hidden = false;
    chat.inert = false;
    page.hidden = true;
    document.getElementById('btnSettings')?.setAttribute('aria-pressed', 'false');
    document.getElementById('chatInput')?.focus();
}

export function initSettingsFrame(): () => void {
    const frame = document.querySelector<HTMLIFrameElement>('#settingsPage iframe');
    if (!frame) return () => {};
    const target = new URL('dist/settings/index.html', document.baseURI);
    if (frame.src !== target.href) frame.src = target.href;
    const sendTheme = (): void => {
        try {
            frame.contentWindow?.postMessage({
                type: 'jaw-preview-theme-sync',
                theme: document.documentElement.dataset['theme'],
            }, window.location.origin);
        } catch (error) {
            console.warn('[settings-frame] theme sync skipped', error);
        }
    };
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const receive = (event: MessageEvent): void => {
        if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
        if (event.data?.type === 'jaw-settings-ready') sendTheme();
        if (event.data?.type === 'settings:back') closeSettingsPage();
    };
    frame.addEventListener('load', sendTheme);
    window.addEventListener('message', receive);
    sendTheme();
    return () => {
        observer.disconnect();
        frame.removeEventListener('load', sendTheme);
        window.removeEventListener('message', receive);
    };
}
