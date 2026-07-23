import type { JSX } from 'react';

interface Props {
    visible: boolean;
    saving: boolean;
    saveDisabled?: boolean;
    onSave(): void;
    onDiscard(): void;
}

export function SaveBar({ visible, saving, saveDisabled = false, onSave, onDiscard }: Props): JSX.Element | null {
    if (!visible && !saving) return null;
    return (
        <div className="d2-settings-save-bar" role="region" aria-label="Unsaved settings">
            <span>You have unsaved changes.</span>
            <div className="d2-settings-save-actions">
                <button type="button" className="d2-settings-button" disabled={saving} onClick={onDiscard}>Discard</button>
                <button type="button" className="d2-settings-button primary" disabled={saving || saveDisabled} onClick={onSave} aria-keyshortcuts="Meta+S Control+S">
                    {saving ? <><span className="d2-settings-spinner" aria-hidden="true" />Saving…</> : 'Save changes'}
                </button>
            </div>
        </div>
    );
}
