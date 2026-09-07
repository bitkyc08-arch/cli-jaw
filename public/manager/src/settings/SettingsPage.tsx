import { useEffect, useRef, type ComponentProps } from 'react';
import { SettingsShell } from './SettingsShell';

type Props = ComponentProps<typeof SettingsShell> & { onBack: () => void; title?: string };

/** Full workspace settings layout; the Shell retains page and save ownership. */
export function SettingsPage({ onBack, title = 'Settings', ...props }: Props) {
    const host = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const previous = document.activeElement;
        host.current?.querySelector<HTMLButtonElement>('.settings-back')?.focus({ preventScroll: true });
        return () => {
            if (previous instanceof HTMLElement && previous.isConnected && previous.getClientRects().length) {
                previous.focus({ preventScroll: true });
            }
        };
    }, []);
    return <div className="settings-full-page" aria-label={title} ref={host}>
        <SettingsShell {...props} onBack={onBack} />
    </div>;
}
