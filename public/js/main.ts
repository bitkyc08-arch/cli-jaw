// ── App Entry Point ──
// All event bindings happen here (no inline onclick in HTML)

// ── Global Error Boundary ──
window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled]', e.reason);
    e.preventDefault();
});
window.addEventListener('error', (e) => {
    console.error('[error]', e.message, e.filename, e.lineno);
});

import { connect } from './ws.js';
import { switchTab, handleSave, loadStats, loadMessages, loadMemory, initMsgCopy } from './ui.js';
import { sendMessage, handleKey, clearAttachedFiles, removeAttachedFile, clearChat, initDragDrop, initAutoResize } from './features/chat.js';
import {
    loadCommands, update as updateSlashDropdown, handleKeydown as handleSlashKeydown,
    handleClick as handleSlashClick, handleOutsideClick as handleSlashOutsideClick,
} from './features/slash-commands.js';
import { loadSkills, toggleSkill, filterSkills } from './features/skills.js';
import {
    loadSettings, setPerm, handleModelSelect, applyCustomModel, onCliChange,
    saveActiveCliSettings, savePerCli, updateSettings, openPromptModal,
    closePromptModal, savePromptFromModal, syncMcpServers, installMcpGlobal,
    loadCliStatus, setTelegram, setForwardAll, saveTelegramSettings, saveFallbackOrder,
    openTemplateModal, saveTemplateFromModal, closeTemplateModal, templateGoBack, toggleDevMode
} from './features/settings.js';
import {
    loadEmployees, addEmployee, deleteEmployee, updateEmployee,
    onEmpCliChange, onEmpRoleChange
} from './features/employees.js';
import {
    openHeartbeatModal, closeHeartbeatModal, addHeartbeatJob,
    removeHeartbeatJob, toggleHeartbeatJob, saveHeartbeatJobs,
    initHeartbeatBadge
} from './features/heartbeat.js';
import {
    openMemoryModal, closeMemoryModal, switchMemTab, setMemEnabled,
    saveMemSettings, deleteMemFile, viewMemFile
} from './features/memory.js';
import { state } from './state.js';
import { loadCliRegistry, getCliKeys } from './constants.js';
import { initAppName } from './features/appname.js';
import { initSidebar, toggleLeft, toggleRight } from './features/sidebar.js';
import { initTheme } from './features/theme.js';
import { initI18n, setLang, getLang, t } from './features/i18n.js';
import { toggleRecording, cancelRecording } from './features/voice-recorder.js';

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
    if (btn) btn.textContent = `🌐 ${t('lang.' + next)}`;
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
document.getElementById('tgToken')?.addEventListener('change', saveTelegramSettings);
document.getElementById('tgChatIds')?.addEventListener('change', saveTelegramSettings);
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
    const tgt = e.target as HTMLInputElement;
    const name = tgt.closest('[data-hb-name]') as HTMLElement | null;
    if (name) { state.heartbeatJobs[+(name.dataset.hbName || '0')].name = tgt.value; saveHeartbeatJobs(); return; }
    const min = tgt.closest('[data-hb-minutes]') as HTMLElement | null;
    if (min) { state.heartbeatJobs[+(min.dataset.hbMinutes || '0')].schedule = { kind: 'every', minutes: +tgt.value }; saveHeartbeatJobs(); return; }
    const prompt = tgt.closest('[data-hb-prompt]') as HTMLElement | null;
    if (prompt) { state.heartbeatJobs[+(prompt.dataset.hbPrompt || '0')].prompt = tgt.value; saveHeartbeatJobs(); return; }
});

// ── Memory Modal ──
document.getElementById('memoryModal')?.addEventListener('click', (e) => closeMemoryModal(e));
document.querySelector('#memoryModal .modal-box')?.addEventListener('click', (e) => e.stopPropagation());
document.querySelector('[data-action="closeMemory"]')?.addEventListener('click', () => closeMemoryModal());
document.getElementById('memTabBtnSettings')?.addEventListener('click', () => switchMemTab('settings'));
document.getElementById('memTabBtnFiles')?.addEventListener('click', () => switchMemTab('files'));
document.getElementById('memOn')?.addEventListener('click', () => setMemEnabled(true));
document.getElementById('memOff')?.addEventListener('click', () => setMemEnabled(false));
document.getElementById('memFlushEvery')?.addEventListener('change', saveMemSettings);
document.getElementById('memCli')?.addEventListener('change', saveMemSettings);
document.getElementById('memModel')?.addEventListener('change', saveMemSettings);
document.getElementById('memRetention')?.addEventListener('change', saveMemSettings);

// Memory files (event delegation)
document.getElementById('memFilesList')?.addEventListener('click', (e) => {
    const del = (e.target as HTMLElement)?.closest('[data-mem-delete]') as HTMLElement | null;
    if (del) { e.stopPropagation(); deleteMemFile(del.dataset.memDelete || ''); return; }
    const view = (e.target as HTMLElement)?.closest('[data-mem-view]') as HTMLElement | null;
    if (view) { viewMemFile(view.dataset.memView || ''); return; }
    const back = (e.target as HTMLElement)?.closest('[data-mem-back]');
    if (back) { openMemoryModal(); return; }
});

// ── Init ──
async function bootstrap(): Promise<void> {
    await initI18n();
    const langBtn = document.getElementById('langToggle');
    if (langBtn) langBtn.textContent = `🌐 ${t('lang.' + getLang())}`;
    await loadCliRegistry();
    bindPerCliControlEvents();
    connect();
    initDragDrop();
    initAutoResize();
    await loadCommands();
    await loadSettings();
    loadCliStatus();
    loadMemory();
    // loadMessages() is handled by ws.js onopen (clear + reload)
    loadEmployees();
    initHeartbeatBadge();
    initAppName();
    initSidebar();
    initTheme();
    initMsgCopy();
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
