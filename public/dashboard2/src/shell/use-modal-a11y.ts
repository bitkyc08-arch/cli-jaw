// M4 — shared modal/popover accessibility behavior.
//
// Two behaviors, extracted so every overlay gets the same implementation
// instead of each component half-remembering them (wp14's overlay-matrix gate
// found every feature modal missing background inert and every overlay except
// SettingsModal missing focus restore):
//
//   focus restore — capture the focused element on mount, give it focus back
//     on unmount. Required for modals, popovers, and menus alike.
//   background inert — everything outside the overlay must be unreachable to
//     pointer, keyboard, and AT while a MODAL is open. A backdrop alone only
//     blocks the pointer.
//
// The inert algorithm walks the overlay's ancestor path and marks each level's
// siblings inert, so the overlay's own subtree stays live no matter where the
// component is mounted (no portal required). Only attributes this hook set
// are ever removed — Workbench owns inert on its workspace surfaces.

import { useEffect } from 'react';

// React's autoFocus commits BEFORE passive effects, so an effect-time
// capture reads the overlay's OWN first field, not the trigger. Track the
// last element focused outside any overlay continuously instead — that is
// always the trigger (or the surface the user came from).
const OVERLAY_ROOTS = '[role="dialog"], [role="menu"], .d2-reminder-edit-scrim, .d2-notes-modal-backdrop, .d2-board-dialog-backdrop, .d2-side-pane-overflow-dropdown';
let lastFreeFocus: HTMLElement | null = null;
if (typeof document !== 'undefined') {
    document.addEventListener('focusin', (event) => {
        const el = event.target;
        if (el instanceof HTMLElement && !el.closest(OVERLAY_ROOTS)) {
            lastFreeFocus = el;
        }
    }, true);
}

function inertOutsideOverlay(overlay: HTMLElement): () => void {
    const selfInerted = new Set<HTMLElement>();
    const observers: MutationObserver[] = [];

    let node: HTMLElement | null = overlay;
    while (node.parentElement) {
        const parent: HTMLElement = node.parentElement;
        const pathNode = node;
        const inertSibling = (candidate: Node): void => {
            if (!(candidate instanceof HTMLElement)) return;
            if (candidate === pathNode) return;
            if (candidate.hasAttribute('inert')) return;
            candidate.setAttribute('inert', '');
            selfInerted.add(candidate);
        };
        for (const sibling of Array.from(parent.children)) inertSibling(sibling);
        // Siblings can mount while the overlay is open (conditional chrome),
        // and this effect does not re-run for that.
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                for (const added of Array.from(record.addedNodes)) inertSibling(added);
            }
        });
        observer.observe(parent, { childList: true });
        observers.push(observer);
        if (parent === document.body) break;
        node = parent;
    }

    return () => {
        for (const observer of observers) observer.disconnect();
        for (const element of selfInerted) element.removeAttribute('inert');
        selfInerted.clear();
    };
}

export interface ModalA11yOptions {
    /** Modals inert the background; popovers and menus must not. */
    inert?: boolean;
    /** Set false when the component owns focus restore itself (notes modals). */
    restore?: boolean;
    /**
     * Components that stay mounted and toggle with an `open` prop pass the
     * prop here; conditionally rendered overlays leave the default (mount ==
     * open, unmount == close).
     */
    active?: boolean;
}

export function useModalA11y(overlaySelector: string | null, options: ModalA11yOptions = {}): void {
    const { inert = false, restore = true, active = true } = options;
    useEffect(() => {
        if (!active) return undefined;
        const restoreTarget = lastFreeFocus;
        // Lists that refresh while an overlay is open (the reminders panel
        // swaps rows for a spinner on each poll) disconnect the original
        // trigger. Re-query the equivalent control by its accessible name.
        const restoreLabel = restoreTarget?.getAttribute('aria-label');
        let cleanupInert: (() => void) | null = null;
        if (inert && overlaySelector) {
            const overlay = document.querySelector(overlaySelector) as HTMLElement | null;
            if (overlay) cleanupInert = inertOutsideOverlay(overlay);
        }
        return () => {
            cleanupInert?.();
            if (restore && (restoreTarget || restoreLabel)) {
                // Restore AFTER the close commit settles: unmount removes the
                // overlay's focused control, and the browser's focus reset to
                // body (plus any sibling effects) would otherwise override a
                // restore issued inside the cleanup itself.
                requestAnimationFrame(() => {
                    const target = restoreTarget?.isConnected
                        ? restoreTarget
                        : (restoreLabel ? document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(restoreLabel)}"]`) : null);
                    if (target?.isConnected) target.focus();
                });
            }
        };
        // Re-running on `active` edges is the point; other deps would
        // re-capture focus the overlay itself took.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);
}
