// Display page: conversation presentation and tui.* fields.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { SelectField, NumberField } from '../fields';
import { presentationMode, type PresentationMode } from '../../../../../src/shared/presentation';
import { describeError } from '../components/error-normalize';
import {
    SettingsSection,
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
} from './page-shell';
import { expandPatch } from './path-utils';

type TuiBlock = {
    pasteCollapseLines?: number;
    pasteCollapseChars?: number;
    keymapPreset?: string;
    diffStyle?: string;
    themeSeed?: string;
};

type DisplaySnapshot = {
    tui?: TuiBlock;
    presentation?: { mode?: PresentationMode };
    [key: string]: unknown;
};

const THEME_OPTIONS = [
    { value: 'jaw-default', label: 'Jaw default' },
    { value: 'jaw-dark', label: 'Jaw dark' },
    { value: 'jaw-light', label: 'Jaw light' },
    { value: 'jaw-contrast', label: 'High contrast' },
];

const KEYMAP_OPTIONS = [
    { value: 'default', label: 'default' },
    { value: 'vim', label: 'vim' },
    { value: 'emacs', label: 'emacs' },
];

const DIFF_OPTIONS = [
    { value: 'summary', label: 'summary' },
    { value: 'unified', label: 'unified' },
    { value: 'side-by-side', label: 'side-by-side' },
];

const DISPLAY_KEYS = [
    'presentation.mode',
    'tui.themeSeed',
    'tui.keymapPreset',
    'tui.pasteCollapseLines',
    'tui.pasteCollapseChars',
    'tui.diffStyle',
] as const;

export default function Display({ port, client, dirty, registerSave }: SettingsPageProps) {
    const { state, refresh, setData } = usePageSnapshot<DisplaySnapshot>(client, '/api/settings', [port]);
    const [draft, setDraft] = useState<TuiBlock>({});
    const [mode, setMode] = useState<PresentationMode>('activity');
    const [saveError, setSaveError] = useState<string | null>(null);
    const activeInstance = useRef<{ client: SettingsPageProps['client']; port: number } | null>(null);

    // Each committed instance gets a distinct generation, including A -> B -> A.
    // Layout cleanup fences pending writes before they can resume after a commit.
    useLayoutEffect(() => {
        activeInstance.current = { client, port };
        return () => { activeInstance.current = null; };
    }, [client, port, dirty]);

    useEffect(() => {
        if (state.kind === 'ready') {
            setDraft({ ...(state.data.tui || {}) });
            setMode(presentationMode(state.data));
        }
    }, [state]);

    useEffect(() => {
        setDraft({});
        setMode('activity');
        setSaveError(null);
        return () => {
            for (const key of DISPLAY_KEYS) dirty.remove(key);
        };
    }, [client, port, dirty]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    const onSave = useCallback(async () => {
        const instance = activeInstance.current;
        if (!instance || instance.client !== client || instance.port !== port) return;
        setSaveError(null);
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return;
        const patch = expandPatch(bundle);
        const updated = await client.put<DisplaySnapshot>('/api/settings', patch);
        if (activeInstance.current !== instance) return;
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: DisplaySnapshot }).data
            : updated) as DisplaySnapshot;
        dirty.clear();
        setDraft({ ...(fresh.tui || {}) });
        setMode(presentationMode(fresh));
        setData(fresh);
        await refresh();
    }, [client, port, dirty, refresh, setData]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const original = state.data.tui || {};

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                const instance = activeInstance.current;
                void onSave().catch((error: unknown) => {
                    if (instance && activeInstance.current === instance) setSaveError(describeError(error));
                });
            }}
        >
            {saveError ? <PageError message={saveError} /> : null}
            <SettingsSection
                title="Conversation display"
                hint="Choose how conversations are displayed."
            >
                <SelectField
                    id="display-presentation-mode"
                    label="Presentation"
                    value={mode}
                    options={[
                        { value: 'activity', label: 'Activity (default)' },
                        { value: 'legacy', label: 'Legacy transcript' },
                    ]}
                    onChange={(next) => {
                        if (next !== 'activity' && next !== 'legacy') return;
                        setMode(next);
                        setEntry('presentation.mode', {
                            value: next,
                            original: presentationMode(state.data),
                            valid: true,
                        });
                    }}
                />
            </SettingsSection>
            <SettingsSection
                title="Display"
                hint={`TUI options applied to /i/${port}.`}
            >
                <SelectField
                    id="display-themeSeed"
                    label="Theme seed"
                    value={draft.themeSeed ?? original.themeSeed ?? 'jaw-default'}
                    options={THEME_OPTIONS}
                    onChange={(next) => {
                        setDraft({ ...draft, themeSeed: next });
                        setEntry('tui.themeSeed', {
                            value: next,
                            original: original.themeSeed ?? 'jaw-default',
                            valid: true,
                        });
                    }}
                />
                <SelectField
                    id="display-keymapPreset"
                    label="Keymap preset"
                    value={draft.keymapPreset ?? original.keymapPreset ?? 'default'}
                    options={KEYMAP_OPTIONS}
                    onChange={(next) => {
                        setDraft({ ...draft, keymapPreset: next });
                        setEntry('tui.keymapPreset', {
                            value: next,
                            original: original.keymapPreset ?? 'default',
                            valid: true,
                        });
                    }}
                />
                <NumberField
                    id="display-pasteCollapseLines"
                    label="Paste collapse — lines"
                    value={draft.pasteCollapseLines ?? original.pasteCollapseLines ?? 2}
                    min={0}
                    step={1}
                    onChange={(next) => {
                        setDraft({ ...draft, pasteCollapseLines: next });
                        setEntry('tui.pasteCollapseLines', {
                            value: next,
                            original: original.pasteCollapseLines ?? 2,
                            valid: Number.isFinite(next) && next >= 0,
                        });
                    }}
                />
                <NumberField
                    id="display-pasteCollapseChars"
                    label="Paste collapse — chars"
                    value={draft.pasteCollapseChars ?? original.pasteCollapseChars ?? 160}
                    min={0}
                    step={10}
                    onChange={(next) => {
                        setDraft({ ...draft, pasteCollapseChars: next });
                        setEntry('tui.pasteCollapseChars', {
                            value: next,
                            original: original.pasteCollapseChars ?? 160,
                            valid: Number.isFinite(next) && next >= 0,
                        });
                    }}
                />
                <SelectField
                    id="display-diffStyle"
                    label="Diff style"
                    value={draft.diffStyle ?? original.diffStyle ?? 'summary'}
                    options={DIFF_OPTIONS}
                    onChange={(next) => {
                        setDraft({ ...draft, diffStyle: next });
                        setEntry('tui.diffStyle', {
                            value: next,
                            original: original.diffStyle ?? 'summary',
                            valid: true,
                        });
                    }}
                />
            </SettingsSection>
        </form>
    );
}
