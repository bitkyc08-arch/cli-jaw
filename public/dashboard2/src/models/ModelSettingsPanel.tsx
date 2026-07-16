import { useMemo, type JSX } from 'react';
import { ModelPicker, modelPickerOptions } from './ModelPicker.tsx';
import { useInstanceModelSettings } from './use-instance-model-settings.ts';
import type { ModelMutationMode } from './model-settings-adapter.ts';

interface ModelSettingsPanelProps {
    port: number | null;
    mode: ModelMutationMode;
    title: string;
    description: string;
}

export function ModelSettingsPanel({ port, mode, title, description }: ModelSettingsPanelProps): JSX.Element {
    const { snapshot, actions } = useInstanceModelSettings({ port, mode });
    const options = useMemo(
        () => modelPickerOptions(snapshot.catalog, snapshot.selection),
        [snapshot.catalog, snapshot.selection],
    );
    const value = options.find(option => (
        option.provider === snapshot.selection?.provider && option.model === snapshot.selection?.model
    )) ?? null;
    const effortOptions = snapshot.selection && snapshot.catalog
        ? snapshot.catalog.effortsByProvider[snapshot.selection.provider]
            ?? snapshot.catalog.effortOptions
        : [];
    const busy = snapshot.status === 'loading' || snapshot.status === 'saving';

    return (
        <section className="d2-settings-page d2-model-settings-panel" aria-labelledby={`model-settings-${mode}`}>
            <header className="d2-settings-page-header">
                <h1 id={`model-settings-${mode}`}>{title}</h1>
                <p>{description}</p>
            </header>
            {port === null ? (
                <div className="d2-settings-state error" role="alert">Select an instance to edit model settings.</div>
            ) : (
                <div className="d2-settings-fields">
                    <div className="d2-settings-field">
                        <ModelPicker
                            label={mode === 'active' ? 'Active provider and model' : 'Default provider and model'}
                            value={value}
                            options={options}
                            effort={snapshot.selection?.effort ?? ''}
                            loading={snapshot.status === 'loading'}
                            pending={snapshot.status === 'saving'}
                            disabled={!snapshot.catalog?.mutationEnabled}
                            error={snapshot.error?.message ?? null}
                            workerWide={mode === 'active'}
                            onSelect={option => {
                                if (!snapshot.selection) return;
                                void actions.save({
                                    ...snapshot.selection,
                                    provider: option.provider,
                                    model: option.model,
                                });
                            }}
                        />
                        {snapshot.catalog?.mutationDisabledReason ? (
                            <small role="note">{snapshot.catalog.mutationDisabledReason}</small>
                        ) : null}
                    </div>
                    <div className="d2-settings-field">
                        <label htmlFor={`model-settings-effort-${mode}`}>
                            <span>{mode === 'active' ? 'Active reasoning effort' : 'Default reasoning effort'}</span>
                            <small>Validated against the selected provider.</small>
                        </label>
                        <select
                            id={`model-settings-effort-${mode}`}
                            value={snapshot.selection?.effort ?? ''}
                            disabled={busy || !snapshot.selection || effortOptions.length === 0}
                            onChange={event => {
                                if (!snapshot.selection) return;
                                void actions.save({ ...snapshot.selection, effort: event.target.value });
                            }}
                        >
                            {effortOptions.map(option => (
                                <option key={option.value || 'default'} value={option.value}>{option.label}</option>
                            ))}
                        </select>
                    </div>
                    {mode === 'default' && snapshot.activeOverrideMasksDefault ? (
                        <div className="d2-model-settings-note" role="note">
                            An active worker-wide override currently masks this default in Chat.
                        </div>
                    ) : null}
                    {snapshot.status === 'saving' ? <div className="d2-model-settings-status" role="status">Saving model settings…</div> : null}
                    {snapshot.error ? (
                        <button type="button" className="d2-sidebar-retry" onClick={actions.reload}>Reload worker settings</button>
                    ) : null}
                </div>
            )}
        </section>
    );
}
