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

        /*
         * Block background interaction by marking the overlay's SIBLINGS inert.
         *
         * The overlay is NOT a direct child of #dashboard2-root: Shell renders a
         * single <main class="d2-shell"> and Sidebar renders this modal inside it.
         * Walking root.children therefore inerted .d2-shell itself, and because
         * inert is inherited by the whole subtree that disabled the modal too —
         * every control died and only the document-level Escape handler survived.
         *
         * We also track exactly which nodes WE marked, so cleanup never clears an
         * inert attribute owned by someone else (Workbench sets inert on its
         * workspace surfaces and side-pane slot).
         */
        const overlay = dialogRef.current?.closest('.d2-settings-modal') as HTMLElement | null;
        const backdropParent = overlay?.parentElement ?? null;
        const selfInerted = new Set<HTMLElement>();

        const inertSibling = (node: Node): void => {
            if (!(node instanceof HTMLElement)) return;
            if (node === overlay) return;
            if (node.hasAttribute('inert')) return;
            node.setAttribute('inert', '');
            selfInerted.add(node);
        };

        let observer: MutationObserver | null = null;
        if (backdropParent && overlay) {
            for (const child of Array.from(backdropParent.children)) inertSibling(child);
            /*
             * Siblings can mount while the modal is open (e.g. Shell's sidebar
             * resize separator is conditional on the responsive breakpoint), and
             * this effect does not re-run for that. Watch for them.
             */
            observer = new MutationObserver((records) => {
                for (const record of records) {
                    for (const added of Array.from(record.addedNodes)) inertSibling(added);
                }
            });
            observer.observe(backdropParent, { childList: true });
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
            observer?.disconnect();
            /* restore ONLY the inert attributes this effect added */
            for (const node of selfInerted) node.removeAttribute('inert');
            selfInerted.clear();
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
