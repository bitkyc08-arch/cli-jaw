import { useCallback, useState } from 'react';
import type { SettingsClient } from '../settings/types';
import { unwrapData, type SettingsData } from './dock-settings';
import type { DockSettingsSnapshot } from './HoverDock';

type Props = {
    client: SettingsClient;
    active: boolean;
    settings: SettingsData;
    snapshot: DockSettingsSnapshot;
};

const ENGINES = [
    { value: 'auto', label: 'Auto' },
    { value: 'gemini', label: 'Gemini' },
    { value: 'openai', label: 'OpenAI-compatible' },
    { value: 'vertex', label: 'Vertex' },
    { value: 'whisper', label: 'Whisper (로컬)' },
];

export function SettingsSttSection({ client, settings, snapshot }: Props) {
    const stt = settings.stt || {};
    const [engine, setEngine] = useState(stt.engine || 'auto');
    const [geminiApiKey, setGeminiApiKey] = useState('');
    const [geminiModel, setGeminiModel] = useState(stt.geminiModel || 'gemini-2.5-flash-lite');
    const [whisperModel, setWhisperModel] = useState(stt.whisperModel || 'mlx-community/whisper-large-v3-turbo');
    const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
    const [openaiApiKey, setOpenaiApiKey] = useState('');
    const [openaiModel, setOpenaiModel] = useState('');
    const [vertexConfig, setVertexConfig] = useState('');
    const [message, setMessage] = useState<string | null>(null);

    const save = useCallback(() => {
        setMessage(null);
        const patch: Record<string, unknown> = {
            engine,
            geminiModel,
            whisperModel,
            openaiBaseUrl,
            openaiModel,
            vertexConfig,
        };
        if (geminiApiKey) patch['geminiApiKey'] = geminiApiKey;
        if (openaiApiKey) patch['openaiApiKey'] = openaiApiKey;
        client.put<unknown>('/api/settings', { stt: patch })
            .then((json) => {
                snapshot.setData(unwrapData<SettingsData>(json));
                setGeminiApiKey('');
                setOpenaiApiKey('');
                setMessage('저장됨');
            })
            .catch((err: unknown) => setMessage(err instanceof Error ? err.message : String(err)));
    }, [client, engine, geminiModel, whisperModel, openaiBaseUrl, openaiModel, vertexConfig, geminiApiKey, openaiApiKey, snapshot]);

    const showGemini = engine === 'auto' || engine === 'gemini';
    const showOpenai = engine === 'openai';
    const showVertex = engine === 'vertex';
    const showWhisper = engine === 'auto' || engine === 'whisper';

    return (
        <div className="dock-section">
            <div className="dock-section-header dock-section-header-static"><span>STT</span></div>
            <label className="dock-field">
                <span>엔진</span>
                <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                    {ENGINES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
            </label>
            {showGemini && (
                <>
                    <label className="dock-field">
                        <span>Gemini API Key</span>
                        <input
                            type="password"
                            value={geminiApiKey}
                            placeholder={stt.geminiKeySet ? `set (${stt.geminiKeyLast4 || '****'})` : 'AIza...'}
                            onChange={(e) => setGeminiApiKey(e.target.value)}
                        />
                    </label>
                    <label className="dock-field">
                        <span>Gemini 모델</span>
                        <input type="text" value={geminiModel} onChange={(e) => setGeminiModel(e.target.value)} />
                    </label>
                </>
            )}
            {showOpenai && (
                <>
                    <label className="dock-field">
                        <span>OpenAI Base URL</span>
                        <input type="text" value={openaiBaseUrl} onChange={(e) => setOpenaiBaseUrl(e.target.value)} />
                    </label>
                    <label className="dock-field">
                        <span>OpenAI API Key</span>
                        <input
                            type="password"
                            value={openaiApiKey}
                            placeholder={stt.openaiKeySet ? `set (${stt.openaiKeyLast4 || '****'})` : 'sk-...'}
                            onChange={(e) => setOpenaiApiKey(e.target.value)}
                        />
                    </label>
                    <label className="dock-field">
                        <span>OpenAI 모델</span>
                        <input type="text" value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)} />
                    </label>
                </>
            )}
            {showVertex && (
                <label className="dock-field">
                    <span>Vertex Config (JSON)</span>
                    <textarea className="dock-prompt-editor" value={vertexConfig} onChange={(e) => setVertexConfig(e.target.value)} />
                </label>
            )}
            {showWhisper && (
                <label className="dock-field">
                    <span>Whisper 모델</span>
                    <input type="text" value={whisperModel} onChange={(e) => setWhisperModel(e.target.value)} />
                </label>
            )}
            <div className="dock-row">
                <button type="button" className="dock-mini-btn" onClick={save}>STT 저장</button>
                {message && <span className="dock-dim">{message}</span>}
            </div>
        </div>
    );
}
