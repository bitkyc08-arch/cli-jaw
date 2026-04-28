// Phase 9 — toast notification.
//
// `aria-live="polite"` so the screen reader announces save results without
// interrupting current speech. Auto-dismisses after a short timeout; the
// dismiss button is rendered for keyboard users.

import { useEffect } from 'react';

export type ToastKind = 'ok' | 'err';

export type ToastShape = { kind: ToastKind; message: string };

type Props = ToastShape & {
    onDismiss: () => void;
    timeoutMs?: number;
};

export function Toast({ kind, message, onDismiss, timeoutMs = 3500 }: Props) {
    useEffect(() => {
        if (timeoutMs <= 0) return;
        const id = setTimeout(onDismiss, timeoutMs);
        return () => clearTimeout(id);
    }, [onDismiss, timeoutMs]);

    return (
        <div
            className={`settings-toast settings-toast-${kind}`}
            role="status"
            aria-live="polite"
        >
            <span className="settings-toast-message">{message}</span>
            <button
                type="button"
                className="settings-toast-dismiss"
                aria-label="Dismiss notification"
                onClick={onDismiss}
            >
                ×
            </button>
        </div>
    );
}
