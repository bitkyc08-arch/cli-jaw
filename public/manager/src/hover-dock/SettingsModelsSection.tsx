import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsClient } from '../settings/types';
import { fetchCliRegistry, toModelMap, type CliRegistry } from './cli-registry';
import { unwrapData, type PerCliConfig, type SettingsData } from './dock-settings';
import type { DockSettingsSnapshot } from './HoverDock';

type Props = {
    client: SettingsClient;
    active: boolean;
    settings: SettingsData;
    snapshot: DockSettingsSnapshot;
};

const HIDDEN_CLIS = new Set(['claude-e']); // legacy display:none parity (050)

export function SettingsModelsSection({ client, active, settings, snapshot }: Props) {
    const [registry, setRegistry] = useState<CliRegistry | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        fetchCliRegistry(client)
            .then((reg) => { if (!cancelled) setRegistry(reg); })
            .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
        return () => { cancelled = true; };
    }, [client, active]);

    const putPerCli = useCallback(async (cli: string, patch: PerCliConfig) => {
        setError(null);
        try {
            const next = unwrapData<SettingsData>(await client.put<unknown>('/api/settings', { perCli: { [cli]: patch } }));
            snapshot.setData(next);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [client, snapshot]);

    const saveAll = useCallback(async () => {
        if (!registry) return;
        const perCli: Record<string, PerCliConfig> = {};
        for (const cli of Object.keys(registry)) {
            const cfg = settings.perCli?.[cli];
            if (cfg) perCli[cli] = cfg;
        }
        setError(null);
        try {
            const next = unwrapData<SettingsData>(await client.put<unknown>('/api/settings', { perCli }));
            snapshot.setData(next);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [client, registry, settings.perCli, snapshot]);

    const modelMap = useMemo(() => (registry ? toModelMap(registry) : {}), [registry]);

    if (error && !registry) return <div className="dock-error">CLI registry 로드 실패: {error}</div>;
    if (!registry) return <div className="dock-loading">로딩 중...</div>;

    return (
        <div className="dock-section">
            <div className="dock-section-header dock-section-header-static">
                <span>CLI별 모델</span>
                <button type="button" className="dock-mini-btn" onClick={() => void saveAll()}>전체 저장</button>
            </div>
            {error && <div className="dock-error">{error}</div>}
            {Object.keys(registry).filter((cli) => !HIDDEN_CLIS.has(cli)).map((cli) => (
                <CliModelCard
                    key={cli}
                    cli={cli}
                    registry={registry}
                    models={modelMap[cli] || []}
                    config={settings.perCli?.[cli] || {}}
                    piSettings={settings.pi}
                    onChange={(patch) => void putPerCli(cli, patch)}
                />
            ))}
        </div>
    );
}

type CardProps = {
    cli: string;
    registry: CliRegistry;
    models: string[];
    config: PerCliConfig;
    piSettings: SettingsData['pi'];
    onChange: (patch: PerCliConfig) => void;
};

function CliModelCard({ cli, registry, models, config, piSettings, onChange }: CardProps) {
    const meta = registry[cli];
    const [customDraft, setCustomDraft] = useState('');
    const [customMode, setCustomMode] = useState(false);
    const hasProviders = cli !== 'pi' && (meta?.providers?.length ?? 0) > 0;
    const provider = hasProviders ? (config.provider || meta?.defaultProvider || '') : '';
    const piProvider = cli === 'pi' ? (config.provider || '') : '';
    const piProfiles = cli === 'pi' ? (piSettings?.profiles || []) : [];
    const piModels = cli === 'pi' && piProvider
        ? (piSettings?.discoveredModels?.[piProvider] || [])
        : [];
    const modelOptions = cli === 'pi' && piModels.length
        ? piModels
        : provider && meta?.modelsByProvider?.[provider]
            ? meta.modelsByProvider[provider]
            : models;
    const model = config.model || 'default';
    const modelInList = modelOptions.includes(model) || model === 'default';
    const effortOptions = provider && meta?.effortsByProvider?.[provider]
        ? meta.effortsByProvider[provider]
        : (meta?.efforts || []);
    const effortDisabled = effortOptions.length === 0 && !!meta?.effortNote;
    const isClaude1m = cli === 'claude' && model.endsWith('[1m]');

    const setModel = (next: string) => {
        if (next === '__custom__') {
            setCustomMode(true);
            return;
        }
        setCustomMode(false);
        onChange({ model: next });
    };
    const commitCustom = () => {
        const value = customDraft.trim();
        if (value) {
            setCustomMode(false);
            onChange({ model: value });
        }
    };
    const toggleClaude1m = (enable: boolean) => {
        const base = model.replace(/\[1m\]$/, '');
        onChange({ model: enable ? `${base}[1m]` : base });
    };

    return (
        <div className="dock-model-card">
            <div className="dock-model-card-title">{meta?.label || cli}</div>
            {cli === 'pi' && piProfiles.length > 0 && (
                <label className="dock-field">
                    <span>Provider</span>
                    <select value={piProvider} onChange={(e) => onChange({ provider: e.target.value })}>
                        {!piProvider && <option value="">—</option>}
                        {piProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label || profile.id}</option>)}
                        {piProvider && !piProfiles.some((p) => p.id === piProvider) && <option value={piProvider}>{piProvider}</option>}
                    </select>
                </label>
            )}
            {hasProviders && (
                <label className="dock-field">
                    <span>Provider</span>
                    <select value={provider} onChange={(e) => onChange({ provider: e.target.value })}>
                        {(meta?.providers || []).map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                </label>
            )}
            <label className="dock-field">
                <span>모델</span>
                <select
                    value={customMode || !modelInList ? '__custom__' : model}
                    disabled={!!meta?.modelNote}
                    title={meta?.modelNote || ''}
                    onChange={(e) => setModel(e.target.value)}
                >
                    {meta?.modelNote
                        ? <option value="">{meta.modelNote}</option>
                        : (
                            <>
                                <option value="default">default</option>
                                {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                                {!modelInList && <option value="__custom__">{model}</option>}
                                <option value="__custom__">직접 입력…</option>
                            </>
                        )}
                </select>
            </label>
            {(customMode || !modelInList) && !meta?.modelNote && (
                <label className="dock-field">
                    <span>모델 ID</span>
                    <input
                        key={`${cli}:${model}`}
                        type="text"
                        defaultValue={modelInList ? '' : model}
                        placeholder="모델 ID"
                        onChange={(e) => setCustomDraft(e.target.value)}
                        onBlur={commitCustom}
                        onKeyDown={(e) => { if (e.key === 'Enter') commitCustom(); }}
                    />
                </label>
            )}
            {(effortOptions.length > 0 || meta?.effortNote) && (
                <label className="dock-field">
                    <span>추론 강도</span>
                    <select
                        value={config.effort ?? ''}
                        disabled={effortDisabled}
                        title={meta?.effortNote || ''}
                        onChange={(e) => onChange({ effort: e.target.value })}
                    >
                        <option value="">{effortDisabled ? meta?.effortNote : '— none'}</option>
                        {effortOptions.map((eff) => <option key={eff} value={eff}>{eff}</option>)}
                    </select>
                </label>
            )}
            {cli === 'claude' && (
                <div className="dock-row dock-toggle-row">
                    <span className="dock-field-label">1M Context</span>
                    <span className="dock-toggle-group">
                        <button type="button" className={`dock-toggle${isClaude1m ? ' is-active' : ''}`} onClick={() => toggleClaude1m(true)}>ON</button>
                        <button type="button" className={`dock-toggle${!isClaude1m ? ' is-active' : ''}`} onClick={() => toggleClaude1m(false)}>OFF</button>
                    </span>
                </div>
            )}
            {cli === 'codex' && (
                <>
                    <div className="dock-row dock-toggle-row">
                        <span className="dock-field-label">Fast Mode</span>
                        <span className="dock-toggle-group">
                            <button type="button" className={`dock-toggle${config.fastMode ? ' is-active' : ''}`} onClick={() => onChange({ fastMode: true })}>ON</button>
                            <button type="button" className={`dock-toggle${!config.fastMode ? ' is-active' : ''}`} onClick={() => onChange({ fastMode: false })}>OFF</button>
                        </span>
                    </div>
                    <div className="dock-row dock-toggle-row">
                        <span className="dock-field-label">1M Context</span>
                        <span className="dock-toggle-group">
                            <button type="button" className={`dock-toggle${config.contextWindow ? ' is-active' : ''}`} onClick={() => onChange({ contextWindow: true })}>ON</button>
                            <button type="button" className={`dock-toggle${!config.contextWindow ? ' is-active' : ''}`} onClick={() => onChange({ contextWindow: false })}>OFF</button>
                        </span>
                    </div>
                    {config.contextWindow && (
                        <>
                            <label className="dock-field">
                                <span>Context Window</span>
                                <input
                                    key={`${cli}:win:${config.contextWindowSize}`}
                                    type="number" min={272000} max={1050000} step={1000}
                                    defaultValue={config.contextWindowSize ?? 1000000}
                                    onBlur={(e) => onChange({ contextWindowSize: parseInt(e.target.value || '1000000', 10) })}
                                />
                            </label>
                            <label className="dock-field">
                                <span>Auto Compact Limit</span>
                                <input
                                    key={`${cli}:compact:${config.contextCompactLimit}`}
                                    type="number" min={100000} max={1000000} step={1000}
                                    defaultValue={config.contextCompactLimit ?? 900000}
                                    onBlur={(e) => onChange({ contextCompactLimit: parseInt(e.target.value || '900000', 10) })}
                                />
                            </label>
                        </>
                    )}
                </>
            )}
        </div>
    );
}
