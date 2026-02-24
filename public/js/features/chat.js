// ── Chat Feature ──
import { state } from '../state.js';
import { addMessage, addSystemMsg, scrollToBottom } from '../ui.js';
import { getPreferredLocale } from '../locale.js';
import { t } from './i18n.js';
import * as slashCmd from './slash-commands.js';

export async function sendMessage() {
    const input = document.getElementById('chatInput');
    const btn = document.getElementById('btnSend');

    // Stop mode: clicking ■ stops the agent
    if (btn.classList.contains('stop-mode') && !input.value.trim() && !state.attachedFile) {
        await fetch('/api/stop', { method: 'POST' });
        return;
    }

    const text = input.value.trim();
    if (!text && !state.attachedFile) return;

    if (text.startsWith('/') && !state.attachedFile) {
        input.value = '';
        resetInputHeight();
        slashCmd.close();
        try {
            let signal, timer;
            if (typeof AbortSignal?.timeout === 'function') {
                signal = AbortSignal.timeout(10000);
            } else {
                const ac = new AbortController();
                signal = ac.signal;
                timer = setTimeout(() => ac.abort(), 10000);
            }
            const locale = getPreferredLocale();
            const res = await fetch('/api/command', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept-Language': locale,
                },
                body: JSON.stringify({ text, locale }),
                signal,
            });
            if (timer) clearTimeout(timer);
            const result = await res.json().catch(() => ({}));
            if (!res.ok && !result?.text) throw new Error(`HTTP ${res.status}`);
            if (result?.code === 'clear_screen') {
                document.getElementById('chatMessages').innerHTML = '';
            }
            if (result?.text) addSystemMsg(result.text, '', result.type);
        } catch (err) {
            addSystemMsg(t('chat.cmd.fail', { msg: err.message }), '', 'error');
        }
        return;
    }

    if (state.attachedFile) {
        const displayMsg = `[📎 ${state.attachedFile.name}] ${text}`;
        addMessage('user', displayMsg);
        input.value = '';
        resetInputHeight();
        try {
            const filePath = await uploadFile(state.attachedFile);
            let prompt = t('chat.file.sent', { path: filePath });
            if (text) prompt += t('chat.file.sentWithMsg', { text });
            clearAttachedFile();
            await fetch('/api/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt }),
            });
        } catch (err) {
            addSystemMsg(t('chat.file.uploadFail', { msg: err.message }));
            clearAttachedFile();
        }
    } else {
        addMessage('user', text);
        input.value = '';
        resetInputHeight();
        const res = await fetch('/api/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: text }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            addSystemMsg(`❌ ${data.error || t('chat.requestFail', { status: res.status })}`, '', 'error');
            return;
        }
        if (data.queued) {
            const { updateQueueBadge } = await import('../ui.js');
            updateQueueBadge(data.pending || 1);
        } else if (data.continued) {
            addSystemMsg(t('chat.continue'));
        }
    }
}

export function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
}

async function uploadFile(file) {
    const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(file.name) },
        body: file,
    });
    if (!res.ok) throw new Error('upload failed');
    const data = await res.json();
    return data.path;
}

export function attachFile(file) {
    state.attachedFile = file;
    const preview = document.getElementById('filePreview');
    const nameEl = document.getElementById('filePreviewName');
    const imgEl = document.getElementById('filePreviewImg');
    nameEl.textContent = `📎 ${file.name} (${(file.size / 1024).toFixed(1)}KB)`;
    if (file.type.startsWith('image/')) {
        imgEl.src = URL.createObjectURL(file);
        imgEl.style.display = 'block';
    } else {
        imgEl.style.display = 'none';
    }
    preview.classList.add('visible');
    document.getElementById('chatInput').focus();
}

export function clearAttachedFile() {
    state.attachedFile = null;
    const preview = document.getElementById('filePreview');
    preview.classList.remove('visible');
    document.getElementById('filePreviewImg').src = '';
    document.getElementById('fileInput').value = '';
}

export async function clearChat() {
    await fetch('/api/clear', { method: 'POST' });
    document.getElementById('chatMessages').innerHTML = '';
}

// ── Auto-resize textarea ──
function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

export function initAutoResize() {
    const el = document.getElementById('chatInput');
    el.addEventListener('input', () => autoResize(el));
}

export function resetInputHeight() {
    const el = document.getElementById('chatInput');
    el.style.height = 'auto';
}

export function initDragDrop() {
    const chatArea = document.querySelector('.chat-area');
    const overlay = document.getElementById('dragOverlay');
    let dragCounter = 0;

    chatArea.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        overlay.classList.add('visible');
    });
    chatArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('visible'); }
    });
    chatArea.addEventListener('dragover', (e) => e.preventDefault());
    chatArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        overlay.classList.remove('visible');
        const file = e.dataTransfer.files[0];
        if (file) attachFile(file);
    });

    document.getElementById('fileInput').addEventListener('change', (e) => {
        if (e.target.files[0]) attachFile(e.target.files[0]);
    });
}
