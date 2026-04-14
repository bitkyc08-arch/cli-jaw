// ── App Entry Point ──
// All event bindings happen here (no inline onclick in HTML)

// CSS imports — bundled by Vite
import 'katex/dist/katex.min.css';

// ── Global Error Boundary ──
window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled]', e.reason);
    e.preventDefault();
});
window.addEventListener('error', (e) => {
    console.error('[error]', e.message, e.filename, e.lineno);
});

import { connect } from './ws.js';
import { switchTab, handleSave, loadMessages, initMsgCopy } from './ui.js';
import { sendMessage, handleKey, clearAttachedFiles, removeAttachedFile, clearChat, initDragDrop, initAutoResize } from './features/chat.js';
import {
    loadCommands, update as updateSlashDropdown, handleKeydown as handleSlashKeydown,
    handleClick as handleSlashClick, handleOutsideClick as handleSlashOutsideClick,
} from './features/slash-commands.js';
import { toggleSkill, filterSkills } from './features/skills.js';
import {
    loadSettings, handleModelSelect, applyCustomModel, onCliChange,
    saveActiveCliSettings, savePerCli, openPromptModal,
    onFlushCliChange, loadFlushAgentSidebar,
    closePromptModal, savePromptFromModal, syncMcpServers, installMcpGlobal,
    loadCliStatus, setTelegram, setForwardAll, setTelegramMentionOnly, saveTelegramSettings,
    setDiscord, setDiscordForwardAll, setDiscordAllowBots, setDiscordMentionOnly, saveDiscordSettings, setActiveChannel,
    saveFallbackOrder,
    openTemplateModal, saveTemplateFromModal, closeTemplateModal, templateGoBack, toggleDevMode
} from './features/settings.js';
const {
    loadEmployees, addEmployee, deleteEmployee, updateEmployee,
    onEmpCliChange, onEmpRoleChange
} = await import('./features/employees.js');
import {
    openHeartbeatModal, closeHeartbeatModal, addHeartbeatJob,
    removeHeartbeatJob, renderHeartbeatJobs, toggleHeartbeatJob, saveHeartbeatJobs,
    initHeartbeatBadge
} from './features/heartbeat.js';
import {
    openMemoryModal, closeMemoryModal, switchMemTab, setMemEnabled,
    saveMemSettings, deleteMemFile, viewMemFile,
    rerunAdvancedBootstrap, reindexAdvancedMemory, upgradeSoulMemory, openCorruptedFolder,
    bindAdvancedProviderUi, triggerFlushNow
} from './features/memory.js';
import { state } from './state.js';
import { loadCliRegistry, getCliKeys } from './constants.js';
import { initAppName } from './features/appname.js';
import { initSidebar, toggleLeft, toggleRight } from './features/sidebar.js';
import { initTheme } from './features/theme.js';
import { initGestures } from './features/gesture.js';
import { initI18n, setLang, getLang, t } from './features/i18n.js';
import { toggleRecording, cancelRecording } from './features/voice-recorder.js';
import { ICONS, hydrateIcons } from './icons.js';
import { hydrateProviderIcons } from './provider-icons.js';

// ── Chat Actions ──
document.getElementById('btnSend')?.addEventListener('click', sendMessage);
const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement | null;
chatInput?.addEventListener('keydown', (e) => {
    if (handleSlashKeydown(e as KeyboardEvent)) return;
    handleKey(e as KeyboardEvent);
});
let slashInputRaf = 0;
chatInput?.addEventListener('input', (e) => {
    if ((e as InputEvent).isComposing) return;
    if (slashInputRaf) cancelAnimationFrame(slashInputRaf);
    slashInputRaf = requestAnimationFrame(() => {
        updateSlashDropdown((e.target as HTMLTextAreaElement)?.value || '');
        slashInputRaf = 0;
    });
});
chatInput?.addEventListener('cmd-execute', () => {
    void sendMessage();
});
document.getElementById('cmdDropdown')?.addEventListener('click', handleSlashClick);
document.addEventListener('click', handleSlashOutsideClick);
document.getElementById('filePreviewClear')?.addEventListener('click', clearAttachedFiles);
document.getElementById('filePreviewList')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement)?.closest('[data-file-idx]') as HTMLElement | null;
    if (btn) removeAttachedFile(+(btn.dataset.fileIdx || '0'));
});
document.querySelector('.btn-attach')?.addEventListener('click', () => {
    (document.getElementById('fileInput') as HTMLInputElement | null)?.click();
});
document.getElementById('btnVoice')?.addEventListener('click', () => toggleRecording());
document.getElementById('btnVoiceCancel')?.addEventListener('click', () => cancelRecording());

// ── Left Sidebar ──
document.getElementById('memorySidebarBtn')?.addEventListener('click', openMemoryModal);
document.getElementById('btnClearChat')?.addEventListener('click', clearChat);
document.getElementById('hbSidebarBtn')?.addEventListener('click', openHeartbeatModal);

// Language toggle
document.getElementById('langToggle')?.addEventListener('click', async () => {
    const next = getLang() === 'ko' ? 'en' : 'ko';
    await setLang(next);
    const btn = document.getElementById('langToggle');
    if (btn) btn.innerHTML = `${ICONS.web} ${t('lang.' + next)}`;
    // Reconnect WS with new locale
    if (state.ws) { state.ws.close(); }
});

// ── Tab Bar (event delegation) ──
document.querySelector('.tab-bar')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement)?.closest('.tab-btn') as HTMLElement | null;
    if (!btn) return;
    const tabs = [...(btn.parentElement?.children || [])].filter(c => c.classList.contains('tab-btn'));
    const idx = tabs.indexOf(btn);
    const names = ['agents', 'skills', 'settings'];
    if (names[idx]) switchTab(names[idx], btn);
});

// ── Save Button ──
document.querySelector('.sidebar-save-bar .btn-save')?.addEventListener('click', handleSave);

// ── Agents Tab ──
document.getElementById('selCli')?.addEventListener('change', () => onCliChange());
document.getElementById('selModel')?.addEventListener('change', () => saveActiveCliSettings());
document.getElementById('selEffort')?.addEventListener('change', () => saveActiveCliSettings());
document.getElementById('flushCli')?.addEventListener('change', () => onFlushCliChange());
document.getElementById('flushModel')?.addEventListener('change', () => onFlushCliChange());
document.querySelector('[data-action="addEmployee"]')?.addEventListener('click', addEmployee);

// ── Employees (Event Delegation) ──
document.getElementById('employeesList')?.addEventListener('click', (e) => {
    const del = (e.target as HTMLElement)?.closest('[data-emp-delete]') as HTMLElement | null;
    if (del) { deleteEmployee(del.dataset.empDelete || ''); return; }
});
document.getElementById('employeesList')?.addEventListener('change', (e) => {
    const tgt = e.target as HTMLSelectElement;
    const name = tgt.closest('[data-emp-name]') as HTMLElement | null;
    if (name) { updateEmployee(name.dataset.empName || '', { name: tgt.value }); return; }
    const cli = tgt.closest('[data-emp-cli]') as HTMLElement | null;
    if (cli) { onEmpCliChange(cli.dataset.empCli || '', tgt.value); return; }
    const model = tgt.closest('[data-emp-model]') as HTMLElement | null;
    if (model) {
        if (tgt.value === '__custom__') {
            const val = prompt(t('model.promptInput'));
            if (val?.trim()) {
                const opt = document.createElement('option');
                opt.value = val.trim(); opt.textContent = val.trim();
                const customOpt = tgt.querySelector('option[value="__custom__"]');
                if (customOpt) tgt.insertBefore(opt, customOpt);
                tgt.value = val.trim();
                updateEmployee(model.dataset.empModel || '', { model: val.trim() });
            } else { tgt.value = 'default'; }
        } else { updateEmployee(model.dataset.empModel || '', { model: tgt.value }); }
        return;
    }
    const role = tgt.closest('[data-emp-role]') as HTMLElement | null;
    if (role) { onEmpRoleChange(role.dataset.empRole || '', tgt.value); return; }
    const custom = tgt.closest('[data-emp-custom]') as HTMLElement | null;
    if (custom) { updateEmployee(custom.dataset.empCustom || '', { role: tgt.value }); return; }
});

// ── Skills Tab (Event Delegation) ──
document.getElementById('skillsList')?.addEventListener('click', (e) => {
    const toggle = (e.target as HTMLElement)?.closest('[data-skill-id]') as HTMLElement | null;
    if (toggle) {
        toggleSkill(toggle.dataset.skillId || '', toggle.dataset.skillEnabled === 'true');
    }
});
// Skill filter buttons (event delegation)
document.querySelector('#tabSkills')?.addEventListener('click', (e) => {
    const filterBtn = (e.target as HTMLElement)?.closest('.skill-filter') as HTMLElement | null;
    if (filterBtn) {
        const cat = filterBtn.dataset.filter || 'all';
        filterSkills(cat, filterBtn);
    }
});

// ── Settings Tab ──
document.querySelector('[data-action="openPrompt"]')?.addEventListener('click', openPromptModal);
document.getElementById('tgOff')?.addEventListener('click', () => setTelegram(false));
document.getElementById('tgOn')?.addEventListener('click', () => setTelegram(true));
document.getElementById('tgForwardOff')?.addEventListener('click', () => setForwardAll(false));
document.getElementById('tgForwardOn')?.addEventListener('click', () => setForwardAll(true));
document.getElementById('tgMentionOff')?.addEventListener('click', () => setTelegramMentionOnly(false));
document.getElementById('tgMentionOn')?.addEventListener('click', () => setTelegramMentionOnly(true));
document.getElementById('tgToken')?.addEventListener('change', saveTelegramSettings);
document.getElementById('tgChatIds')?.addEventListener('change', saveTelegramSettings);
// Discord
document.getElementById('chTelegram')?.addEventListener('click', () => setActiveChannel('telegram'));
document.getElementById('chDiscord')?.addEventListener('click', () => setActiveChannel('discord'));
document.getElementById('dcOff')?.addEventListener('click', () => setDiscord(false));
document.getElementById('dcOn')?.addEventListener('click', () => setDiscord(true));
document.getElementById('dcForwardOff')?.addEventListener('click', () => setDiscordForwardAll(false));
document.getElementById('dcForwardOn')?.addEventListener('click', () => setDiscordForwardAll(true));
document.getElementById('dcAllowBotsOff')?.addEventListener('click', () => setDiscordAllowBots(false));
document.getElementById('dcAllowBotsOn')?.addEventListener('click', () => setDiscordAllowBots(true));
document.getElementById('dcMentionOff')?.addEventListener('click', () => setDiscordMentionOnly(false));
document.getElementById('dcMentionOn')?.addEventListener('click', () => setDiscordMentionOnly(true));
document.getElementById('dcToken')?.addEventListener('change', saveDiscordSettings);
document.getElementById('dcGuildId')?.addEventListener('change', saveDiscordSettings);
document.getElementById('dcChannelIds')?.addEventListener('change', saveDiscordSettings);
document.getElementById('fallbackOrderList')?.addEventListener('change', saveFallbackOrder);

// Codex fast mode toggle
function setCodexFast(on: boolean) {
    const onBtn = document.getElementById('codexFastOn');
    const offBtn = document.getElementById('codexFastOff');
    if (onBtn && offBtn) {
        onBtn.classList.toggle('active', on);
        offBtn.classList.toggle('active', !on);
    }
    savePerCli();
}
document.getElementById('codexFastOn')?.addEventListener('click', () => setCodexFast(true));
document.getElementById('codexFastOff')?.addEventListener('click', () => setCodexFast(false));

// Codex 1M context window toggle
function setCodexCtx(on: boolean) {
    const onBtn = document.getElementById('codexCtxOn');
    const offBtn = document.getElementById('codexCtxOff');
    const valDiv = document.getElementById('codexCtxValues');
    if (onBtn && offBtn) {
        onBtn.classList.toggle('active', on);
        offBtn.classList.toggle('active', !on);
    }
    if (valDiv) valDiv.style.display = on ? '' : 'none';
    savePerCli();
}
document.getElementById('codexCtxOn')?.addEventListener('click', () => setCodexCtx(true));
document.getElementById('codexCtxOff')?.addEventListener('click', () => setCodexCtx(false));
document.getElementById('codexCtxWindow')?.addEventListener('change', savePerCli);
document.getElementById('codexCtxCompact')?.addEventListener('change', savePerCli);

// Claude 1M context toggle — switches model between base and [1m] variant
function setClaude1m(on: boolean) {
    const onBtn = document.getElementById('claude1mOn');
    const offBtn = document.getElementById('claude1mOff');
    const modelSel = document.getElementById('modelClaude') as HTMLSelectElement | null;

    let effective = on;
    if (modelSel) {
        let current = modelSel.value || '';
        if (on && !current.endsWith('[1m]')) {
            const target = current + '[1m]';
            if (Array.from(modelSel.options).some(o => o.value === target)) {
                modelSel.value = target;
            } else {
                effective = false; // no [1m] variant available
            }
        } else if (!on && current.endsWith('[1m]')) {
            const base = current.replace(/\[1m\]$/, '');
            if (Array.from(modelSel.options).some(o => o.value === base)) {
                modelSel.value = base;
            } else {
                effective = true; // can't remove [1m], stay on
            }
        } else {
            effective = current.endsWith('[1m]');
        }
    }
    if (onBtn && offBtn) {
        onBtn.classList.toggle('active', effective);
        offBtn.classList.toggle('active', !effective);
    }
    savePerCli();
}
document.getElementById('claude1mOn')?.addEventListener('click', () => setClaude1m(true));
document.getElementById('claude1mOff')?.addEventListener('click', () => setClaude1m(false));
// Per-CLI model selects
function bindPerCliControlEvents(): void {
    for (const cli of getCliKeys()) {
        const cap = cli.charAt(0).toUpperCase() + cli.slice(1);
        const sel = document.getElementById('model' + cap) as HTMLSelectElement | null;
        if (sel) sel.addEventListener('change', function (this: HTMLSelectElement) { handleModelSelect(cli, this); });
        const custom = document.getElementById('customModel' + cap) as HTMLInputElement | null;
        if (custom) custom.addEventListener('change', function (this: HTMLInputElement) { applyCustomModel(cli, this); });
        const effort = document.getElementById('effort' + cap);
        if (effort) effort.addEventListener('change', savePerCli);
    }
}

// MCP
document.querySelector('[data-action="syncMcp"]')?.addEventListener('click', syncMcpServers);
document.querySelector('[data-action="installMcp"]')?.addEventListener('click', installMcpGlobal);
document.querySelector('[data-action="refreshCli"]')?.addEventListener('click', () => loadCliStatus(true));
document.getElementById('cliStatusInterval')?.addEventListener('change', function (this: HTMLSelectElement) {
    localStorage.setItem('cliStatusInterval', this.value);
});

// ── Prompt Modal ──
document.getElementById('promptModal')?.addEventListener('click', (e) => closePromptModal(e));
document.querySelector('#promptModal .modal-box')?.addEventListener('click', (e) => e.stopPropagation());
document.querySelector('[data-action="closePrompt"]')?.addEventListener('click', () => closePromptModal());
document.querySelector('[data-action="cancelPrompt"]')?.addEventListener('click', () => closePromptModal());
document.querySelector('[data-action="savePrompt"]')?.addEventListener('click', savePromptFromModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !state.isRecording) closePromptModal(); });

// ── Template Modal ──
document.querySelector('[data-action="openTemplates"]')?.addEventListener('click', openTemplateModal);
document.querySelector('[data-action="saveTemplate"]')?.addEventListener('click', saveTemplateFromModal);
document.querySelector('[data-action="closeTemplate"]')?.addEventListener('click', () => closeTemplateModal());
document.getElementById('templateModal')?.addEventListener('click', (e) => closeTemplateModal(e));
document.querySelector('#templateModal .modal-box')?.addEventListener('click', (e) => e.stopPropagation());
document.getElementById('templateBack')?.addEventListener('click', templateGoBack);
document.getElementById('templateDevToggle')?.addEventListener('click', toggleDevMode);

// ── Heartbeat Modal ──
document.getElementById('heartbeatModal')?.addEventListener('click', (e) => closeHeartbeatModal(e));
document.querySelector('#heartbeatModal .modal-box')?.addEventListener('click', (e) => e.stopPropagation());
document.querySelector('[data-action="closeHeartbeat"]')?.addEventListener('click', () => closeHeartbeatModal());
document.querySelector('[data-action="addHeartbeat"]')?.addEventListener('click', addHeartbeatJob);

// Heartbeat jobs (event delegation)
document.getElementById('hbJobsList')?.addEventListener('click', (e) => {
    const toggle = (e.target as HTMLElement)?.closest('[data-hb-toggle]') as HTMLElement | null;
    if (toggle) { toggleHeartbeatJob(+(toggle.dataset.hbToggle || '0')); return; }
    const remove = (e.target as HTMLElement)?.closest('[data-hb-remove]') as HTMLElement | null;
    if (remove) { removeHeartbeatJob(+(remove.dataset.hbRemove || '0')); return; }
});
document.getElementById('hbJobsList')?.addEventListener('change', (e) => {
    const tgt = e.target as HTMLInputElement | HTMLSelectElement;
    const name = tgt.closest('[data-hb-name]') as HTMLElement | null;
    if (name) { state.heartbeatJobs[+(name.dataset.hbName || '0')].name = tgt.value; saveHeartbeatJobs(); return; }
    const kind = tgt.closest('[data-hb-kind]') as HTMLElement | null;
    if (kind) {
        const i = +(kind.dataset.hbKind || '0');
        const current = state.heartbeatJobs[i]?.schedule as Record<string, unknown> | undefined;
        const timeZone = typeof current?.timeZone === 'string' ? current.timeZone : undefined;
        state.heartbeatJobs[i].schedule = tgt.value === 'cron'
            ? { kind: 'cron', cron: typeof current?.cron === 'string' && current.cron.trim() ? current.cron : '0 9 * * *', ...(timeZone ? { timeZone } : {}) }
            : { kind: 'every', minutes: typeof current?.minutes === 'number' && current.minutes > 0 ? Math.floor(current.minutes) : 5, ...(timeZone ? { timeZone } : {}) };
        renderHeartbeatJobs();
        saveHeartbeatJobs();
        return;
    }
    const min = tgt.closest('[data-hb-minutes]') as HTMLElement | null;
    if (min) {
        const i = +(min.dataset.hbMinutes || '0');
        const current = state.heartbeatJobs[i]?.schedule as Record<string, unknown> | undefined;
        const minutes = Math.max(1, Math.floor(Number(tgt.value) || 5));
        const timeZone = typeof current?.timeZone === 'string' ? current.timeZone : undefined;
        state.heartbeatJobs[i].schedule = { kind: 'every', minutes, ...(timeZone ? { timeZone } : {}) };
        renderHeartbeatJobs();
        saveHeartbeatJobs();
        return;
    }
    const cron = tgt.closest('[data-hb-cron]') as HTMLElement | null;
    if (cron) {
        const i = +(cron.dataset.hbCron || '0');
        const current = state.heartbeatJobs[i]?.schedule as Record<string, unknown> | undefined;
        const timeZone = typeof current?.timeZone === 'string' ? current.timeZone : undefined;
        const cronExpr = tgt.value.trim().replace(/\s+/g, ' ');
        state.heartbeatJobs[i].schedule = { kind: 'cron', cron: cronExpr, ...(timeZone ? { timeZone } : {}) };
        renderHeartbeatJobs();
        saveHeartbeatJobs();
        return;
    }
    const timeZone = tgt.closest('[data-hb-timezone]') as HTMLElement | null;
    if (timeZone) {
        const i = +(timeZone.dataset.hbTimezone || '0');
        const current = state.heartbeatJobs[i]?.schedule as Record<string, unknown> | undefined;
        if (current?.kind === 'cron') {
            state.heartbeatJobs[i].schedule = {
                kind: 'cron',
                cron: typeof current.cron === 'string' && current.cron.trim() ? current.cron : '0 9 * * *',
                ...(tgt.value.trim() ? { timeZone: tgt.value.trim() } : {}),
            };
        } else {
            state.heartbeatJobs[i].schedule = {
                kind: 'every',
                minutes: typeof current?.minutes === 'number' && current.minutes > 0 ? Math.floor(current.minutes) : 5,
                ...(tgt.value.trim() ? { timeZone: tgt.value.trim() } : {}),
            };
        }
        renderHeartbeatJobs();
        saveHeartbeatJobs();
        return;
    }
    const prompt = tgt.closest('[data-hb-prompt]') as HTMLElement | null;
    if (prompt) { state.heartbeatJobs[+(prompt.dataset.hbPrompt || '0')].prompt = tgt.value; saveHeartbeatJobs(); return; }
});

// ── Memory Modal ──
document.getElementById('memoryModal')?.addEventListener('click', (e) => closeMemoryModal(e));
document.querySelector('#memoryModal .modal-box')?.addEventListener('click', (e) => e.stopPropagation());
document.querySelector('[data-action="closeMemory"]')?.addEventListener('click', () => closeMemoryModal());
document.getElementById('memTabBtnSettings')?.addEventListener('click', () => switchMemTab('settings'));
document.getElementById('memTabBtnAdvOps')?.addEventListener('click', () => switchMemTab('status'));
document.getElementById('memTabBtnFiles')?.addEventListener('click', () => switchMemTab('files'));
document.getElementById('memOn')?.addEventListener('click', () => setMemEnabled(true));
document.getElementById('memOff')?.addEventListener('click', () => setMemEnabled(false));
document.getElementById('memFlushEvery')?.addEventListener('change', saveMemSettings);
document.getElementById('memCli')?.addEventListener('change', saveMemSettings);
document.getElementById('memModel')?.addEventListener('change', saveMemSettings);
document.getElementById('memRetention')?.addEventListener('change', saveMemSettings);
document.getElementById('memFlushLang')?.addEventListener('change', saveMemSettings);
document.getElementById('memFlushNowBtn')?.addEventListener('click', triggerFlushNow);
document.getElementById('advBootstrapBtn')?.addEventListener('click', rerunAdvancedBootstrap);
document.getElementById('advReindexBtn')?.addEventListener('click', reindexAdvancedMemory);
document.getElementById('advReimportBtn')?.addEventListener('click', rerunAdvancedBootstrap);
document.getElementById('advOpenCorruptedBtn')?.addEventListener('click', openCorruptedFolder);
document.getElementById('advStatusBanner')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement)?.id === 'advUpgradeSoulBtn') upgradeSoulMemory();
});
bindAdvancedProviderUi();

// Memory files (event delegation)
document.getElementById('basicMemoryFiles')?.addEventListener('click', (e) => {
    const del = (e.target as HTMLElement)?.closest('[data-mem-delete]') as HTMLElement | null;
    if (del) { e.stopPropagation(); deleteMemFile(del.dataset.memDelete || ''); return; }
    const view = (e.target as HTMLElement)?.closest('[data-mem-view]') as HTMLElement | null;
    if (view) { viewMemFile(view.dataset.memView || ''); return; }
    const back = (e.target as HTMLElement)?.closest('[data-mem-back]');
    if (back) { openMemoryModal(); return; }
});

// ── Init ──
async function bootstrap(): Promise<void> {
    hydrateIcons();
    hydrateProviderIcons();
    await initI18n();
    const langBtn = document.getElementById('langToggle');
    if (langBtn) langBtn.innerHTML = `${ICONS.web} ${t('lang.' + getLang())}`;
    await loadCliRegistry();
    bindPerCliControlEvents();
    connect();
    initDragDrop();
    initAutoResize();
    await loadCommands();
    await loadSettings();
    loadFlushAgentSidebar();
    loadCliStatus();
    // loadMessages() is handled by ws.js onopen (clear + reload)
    loadEmployees();
    initHeartbeatBadge();
    initAppName();
    initSidebar();
    initTheme();
    initMsgCopy();
    initGestures();

    // Register Service Worker (production only — Vite HMR handles dev)
    if ('serviceWorker' in navigator && !import.meta.env.DEV) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
}

void bootstrap().catch((err: unknown) => {
    console.error('[bootstrap]', err);
});

// ── Keyboard: Escape closes modals ──────────────────
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (state.isRecording) {
            e.preventDefault();
            cancelRecording();
            return;
        }
        document.querySelectorAll('.modal-overlay.open').forEach(m => {
            m.classList.remove('open');
        });
    }
    // Ctrl+Shift+Space (Win/Linux) or Cmd+Shift+Space (Mac) toggles voice recording
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') {
        e.preventDefault();
        toggleRecording();
    }
});

// ── Mobile sidebar toggle (sidebar.js functions reuse) ──
document.getElementById('mobileMenuLeft')?.addEventListener('click', toggleLeft);
document.getElementById('mobileMenuRight')?.addEventListener('click', toggleRight);
