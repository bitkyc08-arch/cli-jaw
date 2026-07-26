// CF-5 — a pointer drag registers document-level listeners that must not
// outlive the component. This session owns the listener lifecycle: it
// attaches move/up/cancel, detaches on pointerup/pointercancel, and exposes
// dispose() so an unmount mid-drag releases the listeners too. The event
// target is injected, so the lifecycle is unit-testable with a plain
// EventTarget (no DOM).

export interface PaneDragHandlers {
    move(ev: Event): void;
    up(): void;
}

export interface PaneDragSession {
    /** Detach every listener. Idempotent; safe to call after a natural end. */
    dispose(): void;
}

type ListenerTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export function beginPaneDrag(target: ListenerTarget, handlers: PaneDragHandlers): PaneDragSession {
    let disposed = false;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
    };
    const move = (ev: Event): void => {
        handlers.move(ev);
    };
    const up = (): void => {
        dispose();
        handlers.up();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
    return { dispose };
}
