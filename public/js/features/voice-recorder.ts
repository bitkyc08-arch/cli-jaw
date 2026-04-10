// ── Voice Recorder Feature ──
// Cross-platform: Chrome/Firefox/Edge (webm/opus), Safari (mp4/aac)
import { state } from '../state.js';
import { addSystemMsg } from '../ui.js';
import { t } from './i18n.js';
import { ICONS } from '../icons.js';
import { sendVoiceToServer } from './chat.js';

let cancelled = false;

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let recordingStream: MediaStream | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let startTime = 0;

/** Pick best supported MIME type for cross-platform */
function pickMime(): string {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
        'audio/webm;codecs=opus',   // Chrome, Firefox, Edge
        'audio/mp4',                 // Safari (macOS/iOS)
        'audio/ogg;codecs=opus',     // Firefox fallback
    ];
    for (const m of candidates) {
        if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return ''; // browser default
}

/** Classify getUserMedia errors into user-friendly messages */
function classifyMicError(err: unknown): string {
    const e = err as DOMException;
    switch (e.name) {
        case 'NotAllowedError':
            return t('voice.micDenied');
        case 'NotFoundError':
            return t('voice.micNotFound');
        case 'NotReadableError':
        case 'AbortError':
            return t('voice.micBusy');
        default:
            if (e instanceof TypeError || !navigator.mediaDevices) {
                return t('voice.httpsRequired');
            }
            return t('voice.micDenied');
    }
}

export async function startRecording(): Promise<void> {
    if (state.isRecording) return;

    // Feature detection
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        addSystemMsg(t('voice.unsupported'), '', 'error');
        return;
    }

    try {
        recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        addSystemMsg(classifyMicError(err), '', 'error');
        return;
    }

    const mimeType = pickMime();
    const options: MediaRecorderOptions = mimeType ? { mimeType } : {};
    mediaRecorder = new MediaRecorder(recordingStream, options);
    chunks = [];

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onerror = () => {
        stopRecording();
        addSystemMsg(t('voice.interrupted'), '', 'error');
    };

    mediaRecorder.onstop = async () => {
        if (cancelled) {
            chunks = [];
            releaseStream();
            cancelled = false;
            return;
        }
        const actualMime = mediaRecorder?.mimeType || mimeType || 'audio/webm';
        const ext = actualMime.includes('mp4') ? '.m4a'
                  : actualMime.includes('ogg') ? '.ogg'
                  : '.webm';
        const blob = new Blob(chunks, { type: actualMime });
        chunks = [];
        releaseStream();

        if (blob.size > 20 * 1024 * 1024) {
            addSystemMsg(t('voice.tooLarge'), '', 'error');
            return;
        }
        if (blob.size < 1000) {
            addSystemMsg(t('voice.tooShort'), '', 'error');
            return;
        }

        await sendVoiceToServer(blob, ext, actualMime);
    };

    // iOS Safari: no timeslice support → call start() without args
    mediaRecorder.start();
    state.isRecording = true;
    startTime = Date.now();
    updateRecordingUI(true);
    startTimer();
}

export function stopRecording(): void {
    if (!state.isRecording || !mediaRecorder) return;
    if (mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
    state.isRecording = false;
    stopTimer();
    updateRecordingUI(false);
}

export function cancelRecording(): void {
    if (!state.isRecording || !mediaRecorder) return;
    cancelled = true;
    if (mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
    state.isRecording = false;
    stopTimer();
    updateRecordingUI(false);
}

export function toggleRecording(): void {
    if (state.isRecording) stopRecording();
    else startRecording();
}

function releaseStream(): void {
    recordingStream?.getTracks().forEach(track => track.stop());
    recordingStream = null;
}

function startTimer(): void {
    const el = document.getElementById('voiceTimer');
    if (!el) return;
    el.style.display = 'inline';
    timerInterval = setInterval(() => {
        const sec = Math.floor((Date.now() - startTime) / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        el.textContent = `${m}:${s}`;
    }, 500);
}

function stopTimer(): void {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    const el = document.getElementById('voiceTimer');
    if (el) { el.style.display = 'none'; el.textContent = '00:00'; }
}

function updateRecordingUI(recording: boolean): void {
    const btn = document.getElementById('btnVoice');
    const cancelBtn = document.getElementById('btnVoiceCancel');
    if (btn) {
        btn.classList.toggle('recording', recording);
        btn.innerHTML = recording ? ICONS.stop : ICONS.mic;
        btn.title = recording ? t('voice.stop') : t('voice.start');
    }
    if (cancelBtn) {
        cancelBtn.style.display = recording ? 'inline-block' : 'none';
    }
}
