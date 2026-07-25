import { X } from '@lucide/icons';
import { useEffect, type JSX } from 'react';
import { Icon } from '../../shell/Icon.tsx';
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
            {/* An SVG, not a `×` glyph. The multiplication sign rendered at 18px
                was the only reason this toast needed a font size outside the
                text hierarchy, and its weight and alignment shifted with the
                system font. */}
            <button type="button" onClick={onDismiss} aria-label="Dismiss notification"><Icon icon={X} size={14} /></button>
        </div>
    );
}
