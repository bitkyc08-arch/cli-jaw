import { useEffect, type JSX } from 'react';
import type { SettingsToastState } from './settings-types.ts';

interface Props extends SettingsToastState { onDismiss(): void }

export function SettingsToast({ kind, message, onDismiss }: Props): JSX.Element {
    useEffect(() => {
        if (kind !== 'success') return undefined;
        const timer = window.setTimeout(onDismiss, 4_000);
        return () => window.clearTimeout(timer);
    }, [kind, onDismiss]);

    return (
        <div className={`d2-settings-toast ${kind}`} role={kind === 'error' ? 'alert' : 'status'} aria-live="polite">
            <span>{message}</span>
            <button type="button" onClick={onDismiss} aria-label="Dismiss notification">×</button>
        </div>
    );
}
