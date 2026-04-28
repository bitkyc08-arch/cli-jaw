// Phase 9 — Dashboard meta page.
//
// Manager-side per-instance metadata that Phase 1 ripped out of the old
// `InstanceDetailPanel`: label, group, favorite, hidden, plus a free-form
// notes field added in this phase. Talks to `/api/dashboard/registry` on
// the manager itself (NOT the per-instance proxy).

import { useCallback, useEffect, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { TextField, ToggleField } from '../fields';
import {
    SettingsSection,
    PageError,
    PageLoading,
    usePageSnapshot,
} from './page-shell';

type RegistryInstance = {
    label: string | null;
    favorite: boolean;
    group: string | null;
    hidden: boolean;
    notes: string | null;
};

type RegistryResponse = {
    registry: {
        instances: Record<string, RegistryInstance>;
    };
};

type Draft = {
    label: string;
    group: string;
    favorite: boolean;
    hidden: boolean;
    notes: string;
};

type ManagerClient = {
    get<T>(path: string): Promise<T>;
    patch<T>(path: string, body: unknown): Promise<T>;
};

function defaultManagerClient(): ManagerClient {
    return {
        async get<T>(path: string): Promise<T> {
            const response = await fetch(path);
            if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);
            return (await response.json()) as T;
        },
        async patch<T>(path: string, body: unknown): Promise<T> {
            const response = await fetch(path, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!response.ok) throw new Error(`PATCH ${path} → ${response.status}`);
            return (await response.json()) as T;
        },
    };
}

const META_KEYS = [
    'meta.label',
    'meta.group',
    'meta.favorite',
    'meta.hidden',
    'meta.notes',
] as const;

function readInstance(snapshot: RegistryResponse | null, port: number): RegistryInstance {
    const raw = snapshot?.registry?.instances?.[String(port)];
    return {
        label: raw?.label ?? null,
        favorite: raw?.favorite === true,
        group: raw?.group ?? null,
        hidden: raw?.hidden === true,
        notes: raw?.notes ?? null,
    };
}

function toDraft(instance: RegistryInstance): Draft {
    return {
        label: instance.label || '',
        group: instance.group || '',
        favorite: instance.favorite,
        hidden: instance.hidden,
        notes: instance.notes || '',
    };
}

export type DashboardMetaProps = SettingsPageProps & {
    /** Tests inject a stub client; production uses fetch. */
    managerClient?: ManagerClient;
};

export default function DashboardMeta({
    port,
    client,
    dirty,
    registerSave,
    managerClient,
}: DashboardMetaProps) {
    // Re-use page-shell's snapshot state for loading/error UI; client.get lands
    // on `/i/{port}/...` which would 404 for this manager-side endpoint, so we
    // pass a fake path and override the loader via React state instead.
    const { state, refresh: _refresh, setData: _setData } = usePageSnapshot<RegistryResponse>(
        client,
        '__dashboard_meta_unused__',
        // Trigger initial reload so our manual loader below runs.
        [port],
    );
    void state; void _refresh; void _setData;

    const [snapshot, setSnapshot] = useState<RegistryResponse | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [draft, setDraft] = useState<Draft>({
        label: '',
        group: '',
        favorite: false,
        hidden: false,
        notes: '',
    });
    const mClient = managerClient || defaultManagerClient();

    useEffect(() => {
        let cancelled = false;
        setLoadError(null);
        mClient
            .get<RegistryResponse>('/api/dashboard/registry')
            .then((res) => {
                if (cancelled) return;
                setSnapshot(res);
                setDraft(toDraft(readInstance(res, port)));
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setLoadError(err instanceof Error ? err.message : String(err));
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [port]);

    useEffect(() => {
        return () => {
            for (const key of META_KEYS) dirty.remove(key);
        };
    }, [dirty]);

    const original = readInstance(snapshot, port);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    const onSave = useCallback(async () => {
        const labelOut = draft.label.trim() || null;
        const groupOut = draft.group.trim() || null;
        const notesOut = draft.notes.trim() || null;
        const patch = {
            instances: {
                [String(port)]: {
                    label: labelOut,
                    group: groupOut,
                    favorite: draft.favorite,
                    hidden: draft.hidden,
                    notes: notesOut,
                },
            },
        };
        const updated = await mClient.patch<RegistryResponse>('/api/dashboard/registry', patch);
        setSnapshot(updated);
        setDraft(toDraft(readInstance(updated, port)));
        for (const key of META_KEYS) dirty.remove(key);
    }, [draft, mClient, dirty, port]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    if (loadError) return <PageError message={loadError} />;
    if (!snapshot) return <PageLoading label="Loading dashboard registry…" />;

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave();
            }}
        >
            <SettingsSection
                title="Dashboard meta"
                hint="Manager-side metadata for this instance. Stored in the dashboard registry."
            >
                <TextField
                    id="dashmeta-label"
                    label="Label"
                    value={draft.label}
                    placeholder="(unset — falls back to home folder name)"
                    onChange={(next) => {
                        setDraft({ ...draft, label: next });
                        setEntry('meta.label', {
                            value: next,
                            original: original.label || '',
                            valid: true,
                        });
                    }}
                />
                <TextField
                    id="dashmeta-group"
                    label="Group"
                    value={draft.group}
                    placeholder="e.g. work, personal"
                    onChange={(next) => {
                        setDraft({ ...draft, group: next });
                        setEntry('meta.group', {
                            value: next,
                            original: original.group || '',
                            valid: true,
                        });
                    }}
                />
                <ToggleField
                    id="dashmeta-favorite"
                    label="Favorite"
                    value={draft.favorite}
                    onChange={(next) => {
                        setDraft({ ...draft, favorite: next });
                        setEntry('meta.favorite', {
                            value: next,
                            original: original.favorite,
                            valid: true,
                        });
                    }}
                />
                <ToggleField
                    id="dashmeta-hidden"
                    label="Hidden"
                    description="Hide from the default instance list."
                    value={draft.hidden}
                    onChange={(next) => {
                        setDraft({ ...draft, hidden: next });
                        setEntry('meta.hidden', {
                            value: next,
                            original: original.hidden,
                            valid: true,
                        });
                    }}
                />
                <label className="settings-field" htmlFor="dashmeta-notes">
                    <span className="settings-field-label">Notes</span>
                    <textarea
                        id="dashmeta-notes"
                        rows={4}
                        value={draft.notes}
                        placeholder="Free-form notes only the dashboard remembers."
                        onChange={(event) => {
                            const next = event.target.value;
                            setDraft({ ...draft, notes: next });
                            setEntry('meta.notes', {
                                value: next,
                                original: original.notes || '',
                                valid: true,
                            });
                        }}
                    />
                </label>
            </SettingsSection>
        </form>
    );
}

export const __test__ = {
    readInstance,
    toDraft,
    META_KEYS,
};
