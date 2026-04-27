import { useEffect, useRef, type ReactNode } from 'react';

type InstanceDrawerProps = {
    open: boolean;
    children: ReactNode;
    onClose: () => void;
};

export function InstanceDrawer(props: InstanceDrawerProps) {
    const { children, onClose, open } = props;
    const closeButtonRef = useRef<HTMLButtonElement | null>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (!open) return;
        previousFocusRef.current = document.activeElement as HTMLElement | null;
        closeButtonRef.current?.focus();
        return () => previousFocusRef.current?.focus();
    }, [open]);

    useEffect(() => {
        if (!open) return;
        function onKeyDown(event: KeyboardEvent): void {
            if (event.key === 'Escape') onClose();
        }
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [onClose, open]);

    if (!open) return null;

    return (
        <div className="drawer-backdrop" onClick={onClose}>
            <aside
                className="instance-drawer"
                role="dialog"
                aria-modal="true"
                aria-label="Instance drawer"
                onClick={event => event.stopPropagation()}
            >
                <div className="drawer-header">
                    <span>Instances</span>
                    <button ref={closeButtonRef} type="button" onClick={onClose}>Close</button>
                </div>
                <div className="drawer-body">{children}</div>
            </aside>
        </div>
    );
}
