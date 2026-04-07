// settings.ts — barrel re-export (preserves all import paths)
export { loadSettings, updateSettings, setPerm, getModelValue, handleModelSelect, applyCustomModel, onCliChange, saveActiveCliSettings, savePerCli } from './settings-core.js';
export { setTelegram, setForwardAll, saveTelegramSettings } from './settings-telegram.js';
export { setDiscord, setDiscordForwardAll, setDiscordAllowBots, saveDiscordSettings } from './settings-discord.js';
export { setActiveChannel, loadFallbackOrder, saveFallbackOrder } from './settings-channel.js';
export { loadMcpServers, syncMcpServers, installMcpGlobal } from './settings-mcp.js';
export { loadCliStatus } from './settings-cli-status.js';
export { initSttSettings } from './settings-stt.js';
export { openPromptModal, closePromptModal, savePromptFromModal, openTemplateModal, saveTemplateFromModal, closeTemplateModal, templateGoBack, toggleDevMode } from './settings-templates.js';
