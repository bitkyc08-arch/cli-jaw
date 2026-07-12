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
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) return undefined;
        const previouslyFocused = document.activeElement;
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', closeOnEscape);
        closeButtonRef.current?.focus();
        return () => {
            document.removeEventListener('keydown', closeOnEscape);
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
                    ref={closeButtonRef}
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
