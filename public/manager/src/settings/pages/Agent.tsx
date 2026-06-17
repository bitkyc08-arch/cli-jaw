import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import {
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
} from './page-shell';
import { parsePermissionsValue } from './Permissions';
import { RuntimeHeader } from './components/agent/RuntimeHeader';
import { PermissionQuickSection } from './components/agent/PermissionQuickSection';
import { FlushAgentSection } from './components/agent/FlushAgentSection';
import { AgentEmployeesSection } from './components/agent/AgentEmployeesSection';
import {
    metaFor,
    optionList,
    runtimeEffortFor,
    runtimeModelFor,
    type ActiveOverride,
    type PerCliEntry,
} from './components/agent/agent-meta';
import {
    runtimeEmployeesEqual,
    runtimeEmployeesHaveErrors,
    unwrapRuntimeEmployees,
    type RuntimeEmployeeRecord,
    type RuntimeEmployeesResponse,
} from './components/agent/runtime-employees-helpers';
import {
    saveAgentRuntime,
    splitAgentSaveBundle,
    type AgentSettingsSnapshot,
} from './components/agent/agent-save';

export { splitAgentSaveBundle };

type AgentSnapshot = AgentSettingsSnapshot & {
    cli?: string;
    workingDir?: string;
    permissions?: 'auto' | string[] | unknown;
    perCli?: Record<string, PerCliEntry>;
    activeOverrides?: Record<string, ActiveOverride>;
};

type FlushSnapshot = {
    cli?: string;
    model?: string;
    [key: string]: unknown;
};

type RuntimeDraft = {
    cli: string;
    provider: string;
    model: string;
    effort: string;
    workingDir: string;
    permissions: 'auto' | string[];
};

export default function Agent({ port, client, dirty, registerSave }: SettingsPageProps) {
    const { state, refresh, setData } = usePageSnapshot<AgentSnapshot>(client, '/api/settings');
    const [draft, setDraft] = useState<RuntimeDraft>({
        cli: '',
        provider: '',
        model: '',
        effort: '',
        workingDir: '',
        permissions: 'auto',
    });
    const [flushOriginal, setFlushOriginal] = useState<FlushSnapshot>({});
    const [flushDraft, setFlushDraft] = useState<FlushSnapshot>({});
    const [flushLoading, setFlushLoading] = useState(true);
    const [flushError, setFlushError] = useState<string | null>(null);
    const [employeeOriginal, setEmployeeOriginal] = useState<RuntimeEmployeeRecord[]>([]);
    const [employeeDraft, setEmployeeDraft] = useState<RuntimeEmployeeRecord[]>([]);
    const [employeeLoading, setEmployeeLoading] = useState(true);
    const [employeeError, setEmployeeError] = useState<string | null>(null);

    const loadFlush = useCallback(async () => {
        setFlushLoading(true);
        setFlushError(null);
        try {
            const data = await client.get<FlushSnapshot>('/api/memory-files');
            const next = { cli: data.cli || '', model: data.model || '' };
            setFlushOriginal(next);
            setFlushDraft(next);
        } catch (err: unknown) {
            setFlushError(err instanceof Error ? err.message : String(err));
        } finally {
            setFlushLoading(false);
        }
    }, [client]);

    const loadEmployees = useCallback(async () => {
        setEmployeeLoading(true);
        setEmployeeError(null);
        try {
            const response = await client.get<RuntimeEmployeesResponse>('/api/employees');
            const rows = unwrapRuntimeEmployees(response);
            setEmployeeOriginal(rows);
            setEmployeeDraft(rows);
        } catch (err: unknown) {
            setEmployeeError(err instanceof Error ? err.message : String(err));
        } finally {
            setEmployeeLoading(false);
        }
    }, [client]);

    useEffect(() => {
        void loadFlush();
        void loadEmployees();
    }, [loadEmployees, loadFlush]);

    useEffect(() => {
        if (state.kind !== 'ready') return;
        const cliKeys = Object.keys(state.data.perCli || {});
        const cli = state.data.cli || cliKeys[0] || '';
        const permissions = parsePermissionsValue(state.data.permissions);
        setDraft({
            cli,
            provider: state.data.perCli?.[cli]?.provider || metaFor(cli).defaultProvider || '',
            model: runtimeModelFor(cli, state.data.perCli, state.data.activeOverrides),
            effort: runtimeEffortFor(cli, state.data.perCli, state.data.activeOverrides),
            workingDir: state.data.workingDir || '',
            permissions: permissions.mode === 'custom' ? permissions.tokens : 'auto',
        });
    }, [state]);

    useEffect(() => {
        return () => {
            for (const key of Array.from(dirty.pending.keys())) {
                if (
                    key === 'cli' ||
                    key === 'workingDir' ||
                    key === 'permissions' ||
                    key === 'runtimeEmployees' ||
                    key === 'flushCli' ||
                    key === 'flushModel' ||
                    key.startsWith('activeOverrides.')
                ) {
                    dirty.remove(key);
                }
            }
        };
    }, [dirty]);

    const setEntry = useCallback((key: string, entry: DirtyEntry) => dirty.set(key, entry), [dirty]);

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return;
        const freshSettings = await saveAgentRuntime({ client, bundle, employeeDraft, employeeOriginal });
        dirty.clear();
        if (freshSettings) setData(freshSettings as AgentSnapshot);
        await refresh();
        await loadFlush();
        await loadEmployees();
    }, [client, dirty, employeeDraft, employeeOriginal, loadEmployees, loadFlush, refresh, setData]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    const settingsData = state.kind === 'ready' ? state.data : {};
    const perCli = settingsData.perCli || {};
    const activeOverrides = settingsData.activeOverrides || {};
    const cliOptions = useMemo(() => Object.keys(perCli), [perCli]);
    const activeMeta = metaFor(draft.cli);
    const activeProvider = draft.provider || activeMeta.defaultProvider || activeMeta.providers?.[0] || '';
    const isPiRuntime = draft.cli === 'pi';
    const hasProviders = !isPiRuntime && (activeMeta.providers?.length ?? 0) > 0;
    const activeModelOptions = hasProviders
        ? optionList(activeMeta.modelsByProvider?.[activeProvider] || activeMeta.models, draft.model)
        : optionList(activeMeta.models, draft.model);
    const activeEffortOptions = hasProviders
        ? (activeMeta.effortsByProvider?.[activeProvider] || activeMeta.efforts)
        : activeMeta.efforts;
    const workingDirError = draft.workingDir.trim() ? null : 'Required';

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    function resetActiveOverrideKeys(): void {
        for (const key of Array.from(dirty.pending.keys())) {
            if (key.startsWith('activeOverrides.')) dirty.remove(key);
        }
    }

    function setRuntimeDraft(next: RuntimeDraft): void {
        setDraft(next);
    }

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave();
            }}
        >
            <RuntimeHeader
                cli={draft.cli}
                cliOptions={cliOptions.length > 0 ? cliOptions : [draft.cli || 'claude']}
                provider={activeProvider}
                providerOptions={isPiRuntime ? [] : (activeMeta.providers || [])}
                model={draft.model}
                modelOptions={activeModelOptions}
                effort={draft.effort}
                effortOptions={activeEffortOptions}
                workingDir={draft.workingDir}
                workingDirError={workingDirError}
                onCliChange={(next) => {
                    const nextDraft = {
                        ...draft,
                        cli: next,
                        provider: perCli[next]?.provider || metaFor(next).defaultProvider || '',
                        model: runtimeModelFor(next, perCli, activeOverrides),
                        effort: runtimeEffortFor(next, perCli, activeOverrides),
                    };
                    resetActiveOverrideKeys();
                    setRuntimeDraft(nextDraft);
                    setEntry('cli', { value: next, original: settingsData.cli || '', valid: true });
                }}
                onProviderChange={(next) => {
                    const models = activeMeta.modelsByProvider?.[next] || [];
                    const efforts = activeMeta.effortsByProvider?.[next] || [];
                    const nextModel = models.includes(draft.model) ? draft.model : (models[0] || '');
                    const nextEffort = efforts.includes(draft.effort) ? draft.effort : '';
                    setRuntimeDraft({ ...draft, provider: next, model: nextModel, effort: nextEffort });
                    setEntry(`perCli.${draft.cli}.provider`, {
                        value: next,
                        original: perCli[draft.cli]?.provider || activeMeta.defaultProvider || '',
                        valid: true,
                    });
                    setEntry(`activeOverrides.${draft.cli}.model`, {
                        value: nextModel,
                        original: runtimeModelFor(draft.cli, perCli, activeOverrides),
                        valid: nextModel.trim().length > 0,
                    });
                    setEntry(`activeOverrides.${draft.cli}.effort`, {
                        value: nextEffort,
                        original: runtimeEffortFor(draft.cli, perCli, activeOverrides),
                        valid: true,
                    });
                }}
                onModelChange={(next) => {
                    setRuntimeDraft({ ...draft, model: next });
                    setEntry(`activeOverrides.${draft.cli}.model`, {
                        value: next,
                        original: runtimeModelFor(draft.cli, perCli, activeOverrides),
                        valid: next.trim().length > 0,
                    });
                }}
                onEffortChange={(next) => {
                    setRuntimeDraft({ ...draft, effort: next });
                    setEntry(`activeOverrides.${draft.cli}.effort`, {
                        value: next,
                        original: runtimeEffortFor(draft.cli, perCli, activeOverrides),
                        valid: true,
                    });
                }}
                onWorkingDirChange={(next) => {
                    setRuntimeDraft({ ...draft, workingDir: next });
                    setEntry('workingDir', {
                        value: next,
                        original: settingsData.workingDir || '',
                        valid: next.trim().length > 0,
                    });
                }}
            />
            <PermissionQuickSection
                value={draft.permissions}
                onChange={(next) => {
                    setRuntimeDraft({ ...draft, permissions: next });
                    setEntry('permissions', {
                        value: next,
                        original: settingsData.permissions ?? 'auto',
                        valid: next === 'auto' || next.length > 0,
                    });
                }}
            />
            <FlushAgentSection
                activeCli={draft.cli}
                flushCli={flushDraft.cli || ''}
                flushModel={flushDraft.model || ''}
                cliOptions={cliOptions}
                modelOptions={optionList(metaFor(flushDraft.cli || draft.cli).models, flushDraft.model || '')}
                loading={flushLoading}
                error={flushError}
                onFlushCliChange={(next) => {
                    const model = next ? metaFor(next).models[0] || '' : '';
                    setFlushDraft({ cli: next, model });
                    setEntry('flushCli', { value: next, original: flushOriginal.cli || '', valid: true });
                    setEntry('flushModel', { value: model, original: flushOriginal.model || '', valid: true });
                }}
                onFlushModelChange={(next) => {
                    setFlushDraft({ ...flushDraft, model: next });
                    setEntry('flushModel', { value: next, original: flushOriginal.model || '', valid: true });
                }}
            />
            <AgentEmployeesSection
                roster={employeeDraft}
                original={employeeOriginal}
                cliOptions={cliOptions}
                loading={employeeLoading}
                error={employeeError}
                onRosterChange={(next) => {
                    setEmployeeDraft(next);
                    if (runtimeEmployeesEqual(next, employeeOriginal)) {
                        dirty.remove('runtimeEmployees');
                        return;
                    }
                    dirty.set('runtimeEmployees', {
                        value: next,
                        original: employeeOriginal,
                        valid: !runtimeEmployeesHaveErrors(next),
                    });
                }}
            />
        </form>
    );
}
