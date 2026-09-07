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

/** Keep the iframe mounted across tab changes so its draft belongs to the Shell. */
export function initSettingsFrame(): () => void {
    const frame = document.querySelector<HTMLIFrameElement>('iframe.settings-frame');
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
