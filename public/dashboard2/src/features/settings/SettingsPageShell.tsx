import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { usePreferences } from '../../providers/preferences-provider.tsx';
import { SaveBar } from './SaveBar.tsx';
import { SettingsToast } from './SettingsToast.tsx';
import {
    fetchDashboardSettings,
    fetchInstanceSettings,
    saveDashboardSettings,
    saveInstanceSettings,
    unwrapSettings,
} from './settings-api.ts';
import type { DirtyStore } from './settings-dirty-store.ts';
import type { SettingsFieldDefinition, SettingsRecord, SettingsSource, SettingsToastState } from './settings-types.ts';

interface Props {
    title: string;
    description: string;
    source: SettingsSource;
    slice?: string;
    fields: SettingsFieldDefinition[];
    port: number | null;
    dirty: DirtyStore;
}

function readPath(record: SettingsRecord, path: string): unknown {
    return path.split('.').reduce<unknown>((value, key) => (
        value && typeof value === 'object' ? (value as SettingsRecord)[key] : undefined
    ), record);
}

function writePath(target: SettingsRecord, path: string, value: unknown): void {
    const keys = path.split('.');
    let cursor = target;
    keys.forEach((key, index) => {
        if (index === keys.length - 1) cursor[key] = value;
        else {
            const next = cursor[key];
            cursor[key] = next && typeof next === 'object' ? { ...next as SettingsRecord } : {};
            cursor = cursor[key] as SettingsRecord;
        }
    });
}

export function SettingsPageShell({ title, description, source, slice, fields, port, dirty }: Props): JSX.Element {
    const scope = `${source}:${port ?? 'manager'}:${slice ?? title}`;
    const { markClean, markDirty, registerActions } = dirty;
    const { theme, locale } = usePreferences();
    const [initial, setInitial] = useState<SettingsRecord>({});
    const [draft, setDraft] = useState<SettingsRecord>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [toast, setToast] = useState<SettingsToastState | null>(null);
    const mounted = useRef(true);

    const load = useCallback(async () => {
        if (source === 'instance' && port === null) {
            setError('Select an instance to edit these settings.');
            setLoading(false);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const response = source === 'dashboard'
                ? await fetchDashboardSettings()
                : await fetchInstanceSettings(port!);
            if (!mounted.current) return;
            const root = unwrapSettings(response);
            const selected = slice ? readPath(root, slice) : root;
            const data = selected && typeof selected === 'object' ? selected as SettingsRecord : {};
            setInitial(data);
            setDraft(data);
            markClean(scope);
        } catch (reason) {
            if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            if (mounted.current) setLoading(false);
        }
    }, [markClean, port, scope, slice, source]);

    useEffect(() => {
        mounted.current = true;
        void load();
        return () => { mounted.current = false; };
    }, [load]);

    const changed = useMemo(() => JSON.stringify(initial) !== JSON.stringify(draft), [draft, initial]);
    useEffect(() => {
        if (changed) markDirty(scope);
        else markClean(scope);
    }, [changed, markClean, markDirty, scope]);

    const discard = useCallback(() => {
        setDraft(initial);
        markClean(scope);
        setToast(null);
    }, [initial, markClean, scope]);

    const save = useCallback(async () => {
        if (!changed || saving) return;
        setSaving(true);
        setToast(null);
        try {
            const patch: SettingsRecord = {};
            if (slice) writePath(patch, slice, draft);
            else Object.assign(patch, draft);
            await (source === 'dashboard' ? saveDashboardSettings(patch) : saveInstanceSettings(port!, patch));
            if (!mounted.current) return;
            setInitial(draft);
            markClean(scope);
            if (source === 'dashboard') {
                const nextTheme = readPath(patch, 'ui.uiTheme');
                const nextLocale = readPath(patch, 'ui.locale');
                if (nextTheme === 'auto' || nextTheme === 'dark' || nextTheme === 'light') theme.setMode(nextTheme);
                if (nextLocale === 'ko' || nextLocale === 'en' || nextLocale === 'zh' || nextLocale === 'ja') locale.setLocale(nextLocale);
            }
            setToast({ kind: 'success', message: `${title} settings saved.` });
        } catch (reason) {
            if (mounted.current) setToast({ kind: 'error', message: reason instanceof Error ? reason.message : String(reason) });
        } finally {
            if (mounted.current) setSaving(false);
        }
    }, [changed, draft, locale, markClean, port, saving, scope, slice, source, theme, title]);

    useEffect(() => {
        registerActions(save, discard);
        return () => registerActions(null, null);
    }, [discard, registerActions, save]);

    const setField = (field: SettingsFieldDefinition, value: unknown): void => {
        setDraft((current) => {
            const next = structuredClone(current);
            writePath(next, field.key, value);
            return next;
        });
    };

    return (
        <section className="d2-settings-page" aria-labelledby={`settings-${scope}-title`}>
            <header className="d2-settings-page-header">
                <h1 id={`settings-${scope}-title`}>{title}</h1>
                <p>{description}</p>
            </header>
            {loading ? <div className="d2-settings-state" role="status"><span className="d2-settings-spinner" />Loading settings…</div> : null}
            {!loading && error ? <div className="d2-settings-state error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>Retry</button></div> : null}
            {!loading && !error ? (
                <div className="d2-settings-fields">
                    {fields.map((field) => {
                        const value = readPath(draft, field.key);
                        const id = `${scope}-${field.key}`.replaceAll('.', '-');
                        return (
                            <div className={`d2-settings-field${field.kind === 'toggle' ? ' toggle' : ''}`} key={field.key}>
                                <label htmlFor={id}><span>{field.label}</span>{field.description ? <small>{field.description}</small> : null}</label>
                                <FieldControl id={id} field={field} value={value} onChange={(next) => setField(field, next)} />
                            </div>
                        );
                    })}
                </div>
            ) : null}
            <SaveBar visible={changed} saving={saving} onSave={() => void save()} onDiscard={discard} />
            {toast ? <SettingsToast {...toast} onDismiss={() => setToast(null)} /> : null}
        </section>
    );
}

function FieldControl({ id, field, value, onChange }: { id: string; field: SettingsFieldDefinition; value: unknown; onChange(value: unknown): void }): JSX.Element {
    if (field.kind === 'toggle') {
        return <button id={id} type="button" className={`d2-settings-switch${value === true ? ' on' : ''}`} role="switch" aria-checked={value === true} onClick={() => onChange(value !== true)}><span /></button>;
    }
    if (field.kind === 'select') {
        return <select id={id} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
    }
    if (field.kind === 'textarea') {
        return <textarea id={id} rows={5} value={String(value ?? '')} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />;
    }
    return <input id={id} type={field.kind === 'secret' ? 'password' : field.kind} value={value === undefined ? '' : String(value)} placeholder={field.placeholder} min={field.min} max={field.max} step={field.step} onChange={(event) => onChange(field.kind === 'number' ? event.target.valueAsNumber : event.target.value)} />;
}
