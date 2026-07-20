import { X } from '@lucide/icons';
import {
    useEffect,
    useRef,
    type JSX,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent,
} from 'react';
import { Icon } from './Icon.tsx';
import { SettingsPanel } from './panels/SettingsPanel.tsx';

export interface SettingsModalProps {
    isOpen: boolean;
    onClose(): void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps): JSX.Element | null {
    const dialogRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) return undefined;
        const previouslyFocused = document.activeElement;

        /* set inert on main content to block background interaction */
        const root = document.getElementById('dashboard2-root');
        const dialogEl = dialogRef.current?.closest('.d2-settings-modal') as HTMLElement | null;
        if (root && dialogEl) {
            /* inert everything except the modal overlay */
            for (const child of Array.from(root.children)) {
                if (child !== dialogEl && child instanceof HTMLElement) {
                    child.setAttribute('inert', '');
                }
            }
        }

        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', closeOnEscape);

        /* focus first interactive control inside the panel (not the close button) */
        requestAnimationFrame(() => {
            const firstControl = dialogRef.current?.querySelector<HTMLElement>(
                '.d2-settings-panel input:not(:disabled), .d2-settings-panel select:not(:disabled), .d2-settings-panel button:not(:disabled)',
            );
            if (firstControl) {
                firstControl.focus();
            } else {
                /* fallback: focus the dialog itself so focus trap still works */
                dialogRef.current?.focus();
            }
        });

        return () => {
            document.removeEventListener('keydown', closeOnEscape);
            /* remove inert from siblings */
            if (root) {
                for (const child of Array.from(root.children)) {
                    if (child instanceof HTMLElement) {
                        child.removeAttribute('inert');
                    }
                }
            }
            if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
        if (event.target === event.currentTarget) onClose();
    };

    const keepFocusInside = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
        if (event.key !== 'Tab') return;
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable?.length) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    return (
        <div className="d2-settings-modal" onMouseDown={closeFromBackdrop}>
            <div
                role="dialog"
                ref={dialogRef}
                aria-modal="true"
                aria-labelledby="d2-settings-title"
                onKeyDown={keepFocusInside}
            >
                <button
                    className="d2-settings-close"
                    type="button"
                    onClick={onClose}
                    aria-label="Close settings"
                    title="Close settings"
                >
                    <Icon icon={X} />
                </button>
                <SettingsPanel />
            </div>
        </div>
    );
}
