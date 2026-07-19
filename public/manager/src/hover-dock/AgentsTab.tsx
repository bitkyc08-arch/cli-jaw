import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsClient } from '../settings/types';
import { fetchCliRegistry, PRIMARY_CLIS, toModelMap, type CliRegistry } from './cli-registry';
import { unwrapData, type SettingsData } from './dock-settings';
import type { DockSettingsSnapshot } from './HoverDock';
import { FlushAgentSection } from './FlushAgentSection';
import { EmployeesSection } from './EmployeesSection';

const SHOW_MORE = '__show_more__';
const CUSTOM = '__custom__';

function useCliRegistry(client: SettingsClient, active: boolean): { registry: CliRegistry | null; error: string | null } {
    const [registry, setRegistry] = useState<CliRegistry | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        fetchCliRegistry(client)
            .then((reg) => { if (!cancelled) { setRegistry(reg); setError(null); } })
            .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
        return () => { cancelled = true; };
    }, [client, active]);
    return { registry, error };
}

type AgentsTabProps = {
    client: SettingsClient;
    active: boolean;
    snapshot: DockSettingsSnapshot;
};

export function AgentsTab({ client, active, snapshot }: AgentsTabProps) {
    const { registry, error: registryError } = useCliRegistry(client, active);
    const { state, refresh, setData } = snapshot;
    const [expanded, setExpanded] = useState(false);
    const [customInput, setCustomInput] = useState('');
    const [customMode, setCustomMode] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const settingsCli = state.kind === 'ready' ? state.data.cli : '';
    // CLI 전환 시 custom 입력 잔여 상태 초기화 (final review #5)
    useEffect(() => {
        setCustomInput('');
        setCustomMode(false);
    }, [settingsCli]);

    const settings = state.kind === 'ready' ? state.data : null;
    const cliKeys = useMemo(() => (registry ? Object.keys(registry) : []), [registry]);
    const modelMap = useMemo(() => (registry ? toModelMap(registry) : {}), [registry]);
    const cli = settings?.cli || cliKeys[0] || '';
    const meta = registry?.[cli] || null;

    const hasProviders = cli !== 'pi' && (meta?.providers?.length ?? 0) > 0;
    const provider = hasProviders
        ? (settings?.perCli?.[cli]?.provider || meta?.defaultProvider || '')
        : '';
    const models = provider && meta?.modelsByProvider?.[provider]
        ? meta.modelsByProvider[provider]
        : (modelMap[cli] || []);
    const savedModel = settings?.activeOverrides?.[cli]?.model || settings?.perCli?.[cli]?.model || 'default';
    const savedEffort = settings?.activeOverrides?.[cli]?.effort ?? settings?.perCli?.[cli]?.effort ?? '';
    const effortOptions = provider && meta?.effortsByProvider?.[provider]
        ? meta.effortsByProvider[provider]
        : (meta?.efforts || []);
    const effortDisabled = effortOptions.length === 0 && !!meta?.effortNote;

    const putSettings = useCallback(async (patch: Record<string, unknown>) => {
        setSaveError(null);
        try {
            const next = unwrapData<SettingsData>(await client.put<unknown>('/api/settings', patch));
            setData(next);
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : String(err));
            await refresh();
        }
    }, [client, refresh, setData]);

    const handleCliChange = useCallback((next: string) => {
        if (next === SHOW_MORE) {
            setExpanded(true);
            return;
        }
        const patch: Record<string, unknown> = { cli: next };
        const nextMeta = registry?.[next];
        if (next !== 'pi' && nextMeta?.providers?.length) {
            // 기존 저장 provider 보존 (final review #1) — 없을 때만 기본값
            patch['perCli'] = { [next]: { provider: settings?.perCli?.[next]?.provider || nextMeta.defaultProvider || nextMeta.providers[0] } };
        }
        void putSettings(patch);
    }, [putSettings, registry, settings?.perCli]);

    const handleProviderChange = useCallback((nextProvider: string) => {
        void putSettings({ perCli: { [cli]: { provider: nextProvider } } });
    }, [cli, putSettings]);

    const saveActiveOverrides = useCallback((model: string, effort: string) => {
        const overrides: Record<string, { model: string; effort?: string }> = { [cli]: { model } };
        if (!effortDisabled) overrides[cli]!.effort = effort;
        const patch: Record<string, unknown> = { activeOverrides: overrides };
        if (hasProviders) patch['perCli'] = { [cli]: { provider } };
        void putSettings(patch);
    }, [cli, effortDisabled, hasProviders, provider, putSettings]);

    const handleModelChange = useCallback((value: string) => {
        if (value === CUSTOM) {
            setCustomMode(true);
            return;
        }
        setCustomMode(false);
        saveActiveOverrides(value, savedEffort);
    }, [saveActiveOverrides, savedEffort]);

    const handleCustomCommit = useCallback(() => {
        const value = customInput.trim();
        if (!value) return;
        setCustomMode(false);
        saveActiveOverrides(value, savedEffort);
    }, [customInput, saveActiveOverrides, savedEffort]);

    const handleEffortChange = useCallback((value: string) => {
        saveActiveOverrides(savedModel, value);
    }, [saveActiveOverrides, savedModel]);

    if (registryError) return <div className="dock-error">CLI registry 로드 실패: {registryError}</div>;
    if (state.kind === 'offline') return <div className="dock-error">인스턴스 오프라인</div>;
    if (state.kind === 'error') return <div className="dock-error">{state.message}</div>;
    if (!registry || !settings) return <div className="dock-loading">로딩 중...</div>;

    const primaryClis = cliKeys.filter((key) => PRIMARY_CLIS.includes(key));
    const secondaryClis = cliKeys.filter((key) => !PRIMARY_CLIS.includes(key));
    const showAll = expanded || (cli && !PRIMARY_CLIS.includes(cli));
    const modelInList = models.includes(savedModel) || savedModel === 'default';

    return (
        <div className="dock-agents">
            <label className="dock-field">
                <span>활성 CLI</span>
                <select value={cli} onChange={(event) => handleCliChange(event.target.value)}>
                    {primaryClis.map((key) => <option key={key} value={key}>{registry[key]?.label || key}</option>)}
                    {secondaryClis.length > 0 && !showAll && <option value={SHOW_MORE}>더 보기…</option>}
                    {secondaryClis.length > 0 && showAll && secondaryClis.map((key) => (
                        <option key={key} value={key}>{registry[key]?.label || key}</option>
                    ))}
                </select>
            </label>
            {hasProviders && (
                <label className="dock-field">
                    <span>Provider</span>
                    <select value={provider} onChange={(event) => handleProviderChange(event.target.value)}>
                        {(meta?.providers || []).map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                </label>
            )}
            <label className="dock-field">
                <span>모델</span>
                <select
                    value={customMode || !modelInList ? CUSTOM : savedModel}
                    disabled={!!meta?.modelNote}
                    title={meta?.modelNote || ''}
                    onChange={(event) => handleModelChange(event.target.value)}
                >
                    {meta?.modelNote
                        ? <option value="">{meta.modelNote}</option>
                        : (
                            <>
                                <option value="default">default</option>
                                {models.map((model) => <option key={model} value={model}>{model}</option>)}
                                {!modelInList && <option value={CUSTOM}>{savedModel}</option>}
                                <option value={CUSTOM}>직접 입력…</option>
                            </>
                        )}
                </select>
            </label>
            {(customMode || !modelInList || customInput) && !meta?.modelNote && (
                <label className="dock-field">
                    <span>모델 ID 직접 입력</span>
                    <input
                        type="text"
                        value={customInput || (modelInList ? '' : savedModel)}
                        placeholder="모델 ID"
                        onChange={(event) => setCustomInput(event.target.value)}
                        onBlur={handleCustomCommit}
                        onKeyDown={(event) => { if (event.key === 'Enter') handleCustomCommit(); }}
                    />
                </label>
            )}
            <label className="dock-field">
                <span>추론 강도</span>
                <select value={savedEffort} disabled={effortDisabled} title={meta?.effortNote || ''} onChange={(event) => handleEffortChange(event.target.value)}>
                    <option value="">{effortDisabled ? meta?.effortNote : '— none'}</option>
                    {effortOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                </select>
            </label>
            <div className="dock-field dock-field-static"><span>권한</span><span>Auto</span></div>
            <div className="dock-field dock-field-static"><span>작업 디렉토리</span><span className="dock-mono">{settings.workingDir}</span></div>
            {saveError && <div className="dock-error">저장 실패: {saveError}</div>}
            <FlushAgentSection client={client} active={active} registry={registry} modelMap={modelMap} activeCli={cli} />
            <EmployeesSection client={client} active={active} registry={registry} modelMap={modelMap} />
        </div>
    );
}
