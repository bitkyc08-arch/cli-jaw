// Phase 2 — Model & Provider page: per-CLI rows + codex extras +
// fallback chip list + active-overrides table with reset button.

import { useCallback, useEffect, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { ChipListField, NumberField } from '../fields';
import {
    SettingsSection,
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
} from './page-shell';
import { PerCliRow } from './components/PerCliRow';
import { metaFor, normalizeCliMetaRegistry } from './components/agent/agent-meta';
import type { CliMeta, PerCliEntry } from './components/agent/agent-meta';
import type { PiSettingsView } from './components/pi-profile';
import { expandPatch } from './path-utils';

type ModelSnapshot = {
    perCli?: Record<string, PerCliEntry>;
    fallbackOrder?: string[];
    activeOverrides?: Record<string, { model?: string; effort?: string }>;
    pi?: PiSettingsView;
    [key: string]: unknown;
};

export function orderModelCliKeys(keys: string[]): string[] {
    return [...keys].sort((a, b) => {
        if (a === 'pi') return -1;
        if (b === 'pi') return 1;
        if (a === 'ai-e') return b === 'pi' ? 1 : -1;
        if (b === 'ai-e') return a === 'pi' ? -1 : 1;
        return 0;
    });
}

// Build a patch that clears every active override. Backend `mergeSettingsPatch`
// shallow-merges per-cli, so we must enumerate known cli keys (current
// overrides + perCli registry) and overwrite each one with empty fields. There
// is no DELETE endpoint as of Phase 2.
export function buildResetOverridesPatch(snapshot: ModelSnapshot): {
    activeOverrides: Record<string, { model: string; effort: string }>;
} {
    const keys = new Set<string>();
    for (const k of Object.keys(snapshot.activeOverrides || {})) keys.add(k);
    for (const k of Object.keys(snapshot.perCli || {})) keys.add(k);
    const activeOverrides: Record<string, { model: string; effort: string }> = {};
    for (const cli of keys) activeOverrides[cli] = { model: '', effort: '' };
    return { activeOverrides };
}

export default function ModelProvider({ port, client, dirty, registerSave }: SettingsPageProps) {
    const { state, refresh, setData } = usePageSnapshot<ModelSnapshot>(client, '/api/settings');
    const [perCliDraft, setPerCliDraft] = useState<Record<string, PerCliEntry>>({});
    const [piDraft, setPiDraft] = useState<PiSettingsView | undefined>(undefined);
    const [fallback, setFallback] = useState<string[]>([]);
    const [codexCtx, setCodexCtx] = useState<{ contextWindowSize?: number; contextWindowCompactLimit?: number }>({});
    const [resetting, setResetting] = useState(false);
    const [resetError, setResetError] = useState<string | null>(null);
    const [cliMeta, setCliMeta] = useState<Record<string, CliMeta> | null>(null);

    const loadCliMeta = useCallback(async () => {
        try {
            const response = await client.get<{ data?: unknown } | Record<string, unknown>>('/api/cli-registry');
            const data = response && typeof response === 'object' && 'data' in response
                ? (response as { data?: unknown }).data
                : response;
            setCliMeta(normalizeCliMetaRegistry(data));
        } catch {
            setCliMeta(null);
        }
    }, [client]);

    useEffect(() => {
        void loadCliMeta();
    }, [loadCliMeta]);

    useEffect(() => {
        if (state.kind !== 'ready') return;
        setPerCliDraft({ ...(state.data.perCli || {}) });
        setPiDraft(state.data.pi);
        setFallback([...(state.data.fallbackOrder || [])]);
        const codex = state.data.perCli?.['codex'] || {};
        const nextCodexCtx: typeof codexCtx = {};
        if (typeof codex.contextWindowSize === 'number') {
            nextCodexCtx.contextWindowSize = codex.contextWindowSize;
        }
        if (typeof codex.contextWindowCompactLimit === 'number') {
            nextCodexCtx.contextWindowCompactLimit = codex.contextWindowCompactLimit;
        }
        setCodexCtx(nextCodexCtx);
    }, [state]);

    useEffect(() => {
        return () => {
            for (const key of Array.from(dirty.pending.keys())) {
                if (key === 'fallbackOrder' || key.startsWith('perCli.')) dirty.remove(key);
            }
        };
    }, [dirty]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return;
        const patch = expandPatch(bundle);
        const updated = await client.put<ModelSnapshot>('/api/settings', patch);
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: ModelSnapshot }).data
            : updated) as ModelSnapshot;
        dirty.clear();
        setData(fresh);
        setPerCliDraft({ ...(fresh.perCli || {}) });
        setFallback([...(fresh.fallbackOrder || [])]);
        await refresh();
        await loadCliMeta();
    }, [client, dirty, loadCliMeta, refresh, setData]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    const onResetOverrides = useCallback(async () => {
        if (state.kind !== 'ready') return;
        if (!window.confirm('Reset all active overrides?')) return;
        setResetting(true);
        setResetError(null);
        try {
            const patch = buildResetOverridesPatch(state.data);
            const updated = await client.put<ModelSnapshot>('/api/settings', patch);
            const fresh = (updated && typeof updated === 'object' && 'data' in updated
                ? (updated as { data: ModelSnapshot }).data
                : updated) as ModelSnapshot;
            setData(fresh);
            await refresh();
        } catch (err: unknown) {
            setResetError(err instanceof Error ? err.message : String(err));
        } finally {
            setResetting(false);
        }
    }, [client, refresh, setData, state]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const data = state.data;
    const perCliOriginal = data.perCli || {};
    const cliKeys = orderModelCliKeys(Object.keys(perCliOriginal));
    const codexOriginal = perCliOriginal['codex'] || {};
    const overrides = data.activeOverrides || {};
    const overrideRows = Object.entries(overrides);

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave();
            }}
        >
            <SettingsSection
                title="Model defaults"
                hint="Per-CLI model and effort defaults apply when no active override is set on the Agent page. Runtime transport is selected separately."
            >
                <p className="settings-percli-note">
                    Native sessions and print compatibility use the same permissions. Transport changes apply to the next run. Changing presentation does not change this selection.
                </p>
                {cliKeys.length === 0 ? (
                    <p className="settings-empty">No CLIs registered for this instance.</p>
                ) : (
                    cliKeys.map((cli) => (
                        <PerCliRow
                            key={cli}
                            cli={cli}
                            meta={metaFor(cli, cliMeta)}
                            original={perCliOriginal[cli] || {}}
                            value={perCliDraft[cli] || perCliOriginal[cli] || {}}
                            setValue={(next) => setPerCliDraft({ ...perCliDraft, [cli]: next })}
                            setEntry={setEntry}
                            client={client}
                            pi={piDraft}
                            setPi={setPiDraft}
                        />
                    ))
                )}
            </SettingsSection>

            {perCliOriginal['codex'] ? (
                <SettingsSection
                    title="Codex context window"
                    hint="Codex-only sliders. Other CLIs ignore these values."
                >
                    <NumberField
                        id="model-codex-ctx"
                        label="Context window size"
                        value={
                            codexCtx.contextWindowSize
                            ?? (typeof codexOriginal.contextWindowSize === 'number'
                                ? codexOriginal.contextWindowSize
                                : 1_000_000)
                        }
                        min={0}
                        step={10_000}
                        onChange={(next) => {
                            setCodexCtx({ ...codexCtx, contextWindowSize: next });
                            setEntry('perCli.codex.contextWindowSize', {
                                value: next,
                                original: codexOriginal.contextWindowSize ?? 1_000_000,
                                valid: Number.isFinite(next) && next >= 0,
                            });
                        }}
                    />
                    <NumberField
                        id="model-codex-compact"
                        label="Compact limit"
                        value={
                            codexCtx.contextWindowCompactLimit
                            ?? (typeof codexOriginal.contextWindowCompactLimit === 'number'
                                ? codexOriginal.contextWindowCompactLimit
                                : 900_000)
                        }
                        min={0}
                        step={10_000}
                        onChange={(next) => {
                            setCodexCtx({ ...codexCtx, contextWindowCompactLimit: next });
                            setEntry('perCli.codex.contextWindowCompactLimit', {
                                value: next,
                                original: codexOriginal.contextWindowCompactLimit ?? 900_000,
                                valid: Number.isFinite(next) && next >= 0,
                            });
                        }}
                    />
                </SettingsSection>
            ) : null}

            <SettingsSection
                title="Fallback order"
                hint="Order of CLIs used when the active CLI fails. Press Enter to add a chip; Backspace to remove the last."
            >
                <ChipListField
                    id="model-fallbackOrder"
                    label="Fallback order"
                    value={fallback}
                    onChange={(next) => {
                        setFallback(next);
                        setEntry('fallbackOrder', {
                            value: next,
                            original: data.fallbackOrder || [],
                            valid: true,
                        });
                    }}
                    placeholder="cli name"
                />
            </SettingsSection>

            <SettingsSection
                title="Active overrides"
                hint="Per-session overrides applied on top of per-CLI defaults."
            >
                {overrideRows.length === 0 ? (
                    <p className="settings-empty">No active overrides.</p>
                ) : (
                    <table className="settings-overrides-table">
                        <thead>
                            <tr>
                                <th scope="col">CLI</th>
                                <th scope="col">Model</th>
                                <th scope="col">Effort</th>
                            </tr>
                        </thead>
                        <tbody>
                            {overrideRows.map(([cli, cfg]) => (
                                <tr key={cli}>
                                    <td>{cli}</td>
                                    <td>
                                        <code>{cfg?.model || '—'}</code>
                                    </td>
                                    <td>
                                        <code>{cfg?.effort || '—'}</code>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <div className="settings-overrides-actions">
                    <button
                        type="button"
                        className="settings-action settings-action-discard"
                        onClick={() => void onResetOverrides()}
                        disabled={resetting || overrideRows.length === 0}
                    >
                        {resetting ? 'Resetting…' : 'Reset overrides'}
                    </button>
                    {resetError ? (
                        <span className="settings-field-error" role="alert">
                            {resetError}
                        </span>
                    ) : null}
                </div>
            </SettingsSection>
        </form>
    );
}
