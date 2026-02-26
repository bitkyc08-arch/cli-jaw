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
    loadCliStatus, setTelegram, saveTelegramSettings, saveFallbackOrder
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

// ── Chat Actions ──
document.getElementById('btnSend').addEventListener('click', sendMessage);
const chatInput = document.getElementById('chatInput');
chatInput.addEventListener('keydown', (e) => {
    if (handleSlashKeydown(e)) return;
    handleKey(e);
});
let slashInputRaf = 0;
chatInput.addEventListener('input', (e) => {
    if (e.isComposing) return;
    if (slashInputRaf) cancelAnimationFrame(slashInputRaf);
    slashInputRaf = requestAnimationFrame(() => {
        updateSlashDropdown(e.target.value);
        slashInputRaf = 0;
    });
});
chatInput.addEventListener('cmd-execute', () => {
    void sendMessage();
});
document.getElementById('cmdDropdown')?.addEventListener('click', handleSlashClick);
document.addEventListener('click', handleSlashOutsideClick);
document.getElementById('filePreviewClear').addEventListener('click', clearAttachedFiles);
document.getElementById('filePreviewList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-file-idx]');
    if (btn) removeAttachedFile(+btn.dataset.fileIdx);
});
document.querySelector('.btn-attach').addEventListener('click', () => {
    document.getElementById('fileInput').click();
});

// ── Left Sidebar ──
document.getElementById('memorySidebarBtn').addEventListener('click', openMemoryModal);
document.getElementById('btnClearChat').addEventListener('click', clearChat);
document.getElementById('hbSidebarBtn').addEventListener('click', openHeartbeatModal);

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
document.querySelector('.tab-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tabs = [...btn.parentElement.children].filter(c => c.classList.contains('tab-btn'));
    const idx = tabs.indexOf(btn);
    const names = ['agents', 'skills', 'settings'];
    if (names[idx]) switchTab(names[idx], btn);
});

// ── Save Button ──
document.querySelector('.sidebar-save-bar .btn-save').addEventListener('click', handleSave);

// ── Agents Tab ──
document.getElementById('selCli').addEventListener('change', () => onCliChange());
document.getElementById('selModel').addEventListener('change', () => saveActiveCliSettings());
document.getElementById('selEffort').addEventListener('change', () => saveActiveCliSettings());
document.getElementById('inpCwd').addEventListener('change', updateSettings);
document.querySelector('[data-action="addEmployee"]').addEventListener('click', addEmployee);

// ── Employees (Event Delegation) ──
document.getElementById('employeesList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-emp-delete]');
    if (del) { deleteEmployee(del.dataset.empDelete); return; }
});
document.getElementById('employeesList').addEventListener('change', (e) => {
    const name = e.target.closest('[data-emp-name]');
    if (name) { updateEmployee(name.dataset.empName, { name: e.target.value }); return; }
    const cli = e.target.closest('[data-emp-cli]');
    if (cli) { onEmpCliChange(cli.dataset.empCli, e.target.value); return; }
    const model = e.target.closest('[data-emp-model]');
    if (model) {
        if (e.target.value === '__custom__') {
            const val = prompt(t('model.promptInput'));
            if (val?.trim()) {
                const opt = document.createElement('option');
                opt.value = val.trim(); opt.textContent = val.trim();
                const customOpt = e.target.querySelector('option[value="__custom__"]');
                e.target.insertBefore(opt, customOpt);
                e.target.value = val.trim();
                updateEmployee(model.dataset.empModel, { model: val.trim() });
            } else { e.target.value = 'default'; }
        } else { updateEmployee(model.dataset.empModel, { model: e.target.value }); }
        return;
    }
    const role = e.target.closest('[data-emp-role]');
    if (role) { onEmpRoleChange(role.dataset.empRole, e.target.value); return; }
    const custom = e.target.closest('[data-emp-custom]');
    if (custom) { updateEmployee(custom.dataset.empCustom, { role: e.target.value }); return; }
});

// ── Skills Tab (Event Delegation) ──
document.getElementById('skillsList').addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-skill-id]');
    if (toggle) {
        toggleSkill(toggle.dataset.skillId, toggle.dataset.skillEnabled === 'true');
    }
});
// Skill filter buttons (event delegation)
document.querySelector('#tabSkills').addEventListener('click', (e) => {
    const filterBtn = e.target.closest('.skill-filter');
    if (filterBtn) {
        const cat = filterBtn.dataset.filter;
        filterSkills(cat, filterBtn);
    }
});

// ── Settings Tab ──
document.querySelector('[data-action="openPrompt"]').addEventListener('click', openPromptModal);
document.getElementById('tgOff').addEventListener('click', () => setTelegram(false));
document.getElementById('tgOn').addEventListener('click', () => setTelegram(true));
document.getElementById('tgToken').addEventListener('change', saveTelegramSettings);
document.getElementById('tgChatIds').addEventListener('change', saveTelegramSettings);
document.getElementById('fallbackOrderList').addEventListener('change', saveFallbackOrder);

// Per-CLI model selects
function bindPerCliControlEvents() {
    for (const cli of getCliKeys()) {
        const cap = cli.charAt(0).toUpperCase() + cli.slice(1);
        const sel = document.getElementById('model' + cap);
        if (sel) sel.addEventListener('change', function () { handleModelSelect(cli, this); });
        const custom = document.getElementById('customModel' + cap);
        if (custom) custom.addEventListener('change', function () { applyCustomModel(cli, this); });
        const effort = document.getElementById('effort' + cap);
        if (effort) effort.addEventListener('change', savePerCli);
    }
}

// MCP
document.querySelector('[data-action="syncMcp"]').addEventListener('click', syncMcpServers);
document.querySelector('[data-action="installMcp"]').addEventListener('click', installMcpGlobal);
document.querySelector('[data-action="refreshCli"]').addEventListener('click', () => loadCliStatus(true));
document.getElementById('cliStatusInterval').addEventListener('change', function () {
    localStorage.setItem('cliStatusInterval', this.value);
});

// ── Prompt Modal ──
document.getElementById('promptModal').addEventListener('click', (e) => closePromptModal(e));
document.querySelector('#promptModal .modal-box').addEventListener('click', (e) => e.stopPropagation());
document.querySelector('[data-action="closePrompt"]').addEventListener('click', () => closePromptModal());
document.querySelector('[data-action="cancelPrompt"]').addEventListener('click', () => closePromptModal());
document.querySelector('[data-action="savePrompt"]').addEventListener('click', savePromptFromModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePromptModal(); });

// ── Heartbeat Modal ──
document.getElementById('heartbeatModal').addEventListener('click', (e) => closeHeartbeatModal(e));
document.querySelector('#heartbeatModal .modal-box').addEventListener('click', (e) => e.stopPropagation());
document.querySelector('[data-action="closeHeartbeat"]').addEventListener('click', () => closeHeartbeatModal());
document.querySelector('[data-action="addHeartbeat"]').addEventListener('click', addHeartbeatJob);

// Heartbeat jobs (event delegation)
document.getElementById('hbJobsList').addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-hb-toggle]');
    if (toggle) { toggleHeartbeatJob(+toggle.dataset.hbToggle); return; }
    const remove = e.target.closest('[data-hb-remove]');
    if (remove) { removeHeartbeatJob(+remove.dataset.hbRemove); return; }
});
document.getElementById('hbJobsList').addEventListener('change', (e) => {
    const name = e.target.closest('[data-hb-name]');
    if (name) { state.heartbeatJobs[+name.dataset.hbName].name = e.target.value; saveHeartbeatJobs(); return; }
    const min = e.target.closest('[data-hb-minutes]');
    if (min) { state.heartbeatJobs[+min.dataset.hbMinutes].schedule = { kind: 'every', minutes: +e.target.value }; saveHeartbeatJobs(); return; }
    const prompt = e.target.closest('[data-hb-prompt]');
    if (prompt) { state.heartbeatJobs[+prompt.dataset.hbPrompt].prompt = e.target.value; saveHeartbeatJobs(); return; }
});

// ── Memory Modal ──
document.getElementById('memoryModal').addEventListener('click', (e) => closeMemoryModal(e));
document.querySelector('#memoryModal .modal-box').addEventListener('click', (e) => e.stopPropagation());
document.querySelector('[data-action="closeMemory"]').addEventListener('click', () => closeMemoryModal());
document.getElementById('memTabBtnSettings').addEventListener('click', () => switchMemTab('settings'));
document.getElementById('memTabBtnFiles').addEventListener('click', () => switchMemTab('files'));
document.getElementById('memOn').addEventListener('click', () => setMemEnabled(true));
document.getElementById('memOff').addEventListener('click', () => setMemEnabled(false));
document.getElementById('memFlushEvery').addEventListener('change', saveMemSettings);
document.getElementById('memCli').addEventListener('change', saveMemSettings);
document.getElementById('memModel').addEventListener('change', saveMemSettings);
document.getElementById('memRetention').addEventListener('change', saveMemSettings);

// Memory files (event delegation)
document.getElementById('memFilesList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-mem-delete]');
    if (del) { e.stopPropagation(); deleteMemFile(del.dataset.memDelete); return; }
    const view = e.target.closest('[data-mem-view]');
    if (view) { viewMemFile(view.dataset.memView); return; }
    const back = e.target.closest('[data-mem-back]');
    if (back) { openMemoryModal(); return; }
});

// ── Init ──
async function bootstrap() {
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

void bootstrap().catch((err) => {
    console.error('[bootstrap]', err);
});

// ── Keyboard: Escape closes modals ──────────────────
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay.open').forEach(m => {
            m.classList.remove('open');
        });
    }
});

// ── Mobile sidebar toggle (sidebar.js functions reuse) ──
document.getElementById('mobileMenuLeft')?.addEventListener('click', toggleLeft);
document.getElementById('mobileMenuRight')?.addEventListener('click', toggleRight);
