// Phase 9 — shell-level floating save bar.
//
// Renders sticky at the bottom of the settings page area whenever the dirty
// store has pending changes (or a save is in flight, or there's a lingering
// error). Pages no longer render their own save bars — the shell registers
// a save handler and the dirty store decides when to show this.

type Props = {
    isDirty: boolean;
    saving: boolean;
    pendingCount: number;
    error: string | null;
    onDiscard: () => void;
    onSave: () => void;
};

export function SaveBar({ isDirty, saving, pendingCount, error, onDiscard, onSave }: Props) {
    if (!isDirty && !saving && !error) return null;
    return (
        <div
            className="settings-save-bar"
            role="region"
            aria-label="Save changes"
            data-testid="settings-save-bar"
        >
            {error ? (
                <span className="settings-save-bar-error" role="alert">
                    {error}
                </span>
            ) : (
                <span className="settings-save-bar-status muted">
                    {pendingCount === 0
                        ? 'No pending changes.'
                        : `${pendingCount} pending change${pendingCount === 1 ? '' : 's'}`}
                </span>
            )}
            <button
                type="button"
                className="settings-action settings-action-discard"
                onClick={onDiscard}
                disabled={saving || !isDirty}
            >
                Discard
            </button>
            <button
                type="button"
                className="settings-action settings-action-save"
                onClick={onSave}
                disabled={saving || !isDirty}
                aria-keyshortcuts="Meta+S Control+S"
            >
                {saving ? 'Saving…' : 'Save'}
            </button>
        </div>
    );
}
