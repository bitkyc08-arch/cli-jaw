// ── STT Settings ──
import { apiJson } from '../api.js';
import { t } from './i18n.js';

export function initSttSettings(sttConfig: Record<string, any>): void {
    const engine = document.getElementById('sttEngine') as HTMLSelectElement | null;
    const geminiKey = document.getElementById('sttGeminiKey') as HTMLInputElement | null;
    const geminiModel = document.getElementById('sttGeminiModel') as HTMLSelectElement | null;
    const geminiModelCustom = document.getElementById('sttGeminiModelCustom') as HTMLInputElement | null;
    const whisperModel = document.getElementById('sttWhisperModel') as HTMLInputElement | null;
    const openaiBaseUrl = document.getElementById('sttOpenaiBaseUrl') as HTMLInputElement | null;
    const openaiKey = document.getElementById('sttOpenaiKey') as HTMLInputElement | null;
    const openaiModel = document.getElementById('sttOpenaiModel') as HTMLInputElement | null;
    const vertexJson = document.getElementById('sttVertexJson') as HTMLTextAreaElement | null;

    if (engine) engine.value = sttConfig.engine || 'auto';
    if (geminiKey) geminiKey.placeholder = sttConfig.geminiKeySet ? savedKeyPlaceholder(sttConfig.geminiKeyLast4) : 'AIza...';
    if (geminiModel) {
        const saved = sttConfig.geminiModel || 'gemini-2.5-flash-lite';
        const hasOption = Array.from(geminiModel.options).some(o => o.value === saved);
        if (hasOption) { geminiModel.value = saved; }
        else { geminiModel.value = '__custom__'; if (geminiModelCustom) { geminiModelCustom.value = saved; geminiModelCustom.style.display = ''; } }
    }
    if (whisperModel) whisperModel.value = sttConfig.whisperModel || 'mlx-community/whisper-large-v3-turbo';
    if (openaiBaseUrl) openaiBaseUrl.value = sttConfig.openaiBaseUrl || '';
    if (openaiKey) openaiKey.placeholder = sttConfig.openaiKeySet ? savedKeyPlaceholder(sttConfig.openaiKeyLast4) : 'sk-...';
    if (openaiModel) openaiModel.value = sttConfig.openaiModel || '';
    if (vertexJson) vertexJson.value = sttConfig.vertexConfig || '';

    function toggleProviderFields() {
        const v = engine?.value || 'auto';
        const showGemini = v === 'auto' || v === 'gemini';
        const showOpenai = v === 'openai';
        const showVertex = v === 'vertex';
        const showWhisper = v === 'auto' || v === 'whisper';
        document.querySelectorAll('.stt-gemini').forEach(el => (el as HTMLElement).style.display = showGemini ? '' : 'none');
        document.querySelectorAll('.stt-openai').forEach(el => (el as HTMLElement).style.display = showOpenai ? '' : 'none');
        document.querySelectorAll('.stt-vertex').forEach(el => (el as HTMLElement).style.display = showVertex ? '' : 'none');
        document.querySelectorAll('.stt-whisper').forEach(el => (el as HTMLElement).style.display = showWhisper ? '' : 'none');
    }
    toggleProviderFields();

    async function saveStt() {
        const patch: Record<string, any> = {
            stt: {
                engine: engine?.value || 'auto',
                geminiModel: (geminiModel?.value === '__custom__' ? geminiModelCustom?.value : geminiModel?.value) || 'gemini-2.5-flash-lite',
                whisperModel: whisperModel?.value || '',
                openaiBaseUrl: openaiBaseUrl?.value || '',
                openaiModel: openaiModel?.value || '',
                vertexConfig: vertexJson?.value || '',
            },
        };
        if (geminiKey?.value) patch.stt.geminiApiKey = geminiKey.value;
        if (openaiKey?.value) patch.stt.openaiApiKey = openaiKey.value;
        console.log('[stt] saving:', { engine: patch.stt.engine, hasGeminiKey: !!patch.stt.geminiApiKey, hasOpenaiKey: !!patch.stt.openaiApiKey });
        try {
            await apiJson('/api/settings', 'PUT', patch);
            if (geminiKey?.value) { const l4 = geminiKey.value.slice(-4); geminiKey.value = ''; geminiKey.placeholder = savedKeyPlaceholder(l4); }
            if (openaiKey?.value) { const l4 = openaiKey.value.slice(-4); openaiKey.value = ''; openaiKey.placeholder = savedKeyPlaceholder(l4); }
        } catch (e) {
            console.error('[stt] save failed:', e);
        }
    }

    // Auto-save on change (selects) and blur (text/password inputs)
    engine?.addEventListener('change', () => { toggleProviderFields(); saveStt(); });
    geminiModel?.addEventListener('change', () => {
        if (geminiModelCustom) geminiModelCustom.style.display = geminiModel.value === '__custom__' ? '' : 'none';
        if (geminiModel.value !== '__custom__') saveStt();
    });
    geminiModelCustom?.addEventListener('blur', saveStt);
    geminiKey?.addEventListener('blur', () => { if (geminiKey.value) saveStt(); });
    openaiKey?.addEventListener('blur', () => { if (openaiKey.value) saveStt(); });
    openaiBaseUrl?.addEventListener('blur', saveStt);
    openaiModel?.addEventListener('blur', saveStt);
    whisperModel?.addEventListener('blur', saveStt);
    vertexJson?.addEventListener('blur', saveStt);
}

function savedKeyPlaceholder(last4: unknown): string {
    return t('stt.key.savedPlaceholder', { last4: last4 || '' });
}
