import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

// Slice 216: modal accessibility (focus trap + restore) and visible SSE transport state.

test('command popup traps Tab focus and restores focus on close', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    assert.ok(popup.includes('const dialogRef = useRef<HTMLElement>(null)'), 'popup needs a dialog ref for the focus trap');
    assert.ok(popup.includes('ref={dialogRef}'), 'dialog section uses the ref');
    assert.ok(popup.includes("event.key === 'Tab'"), 'popup handles Tab for the focus trap');
    assert.ok(popup.includes('dialogRef.current.querySelectorAll'), 'focus trap queries focusable elements within the dialog');
    assert.ok(popup.includes('event.shiftKey && active === first') && popup.includes('active === last'), 'focus wraps at both boundaries');
    // Focus restore: store the previously-focused element and restore on unmount.
    assert.ok(popup.includes('document.activeElement as HTMLElement | null'), 'popup captures the previously focused element');
    assert.ok(popup.includes('previouslyFocused?.focus?.()'), 'popup restores focus on close');
});

test('useCodeEvents exposes SSE transport state (connected / reconnecting / disconnected)', () => {
    const hook = read('public/manager/src/code/useCodeEvents.ts');
    assert.ok(hook.includes("export type CodeTransportState = 'connected' | 'reconnecting' | 'disconnected'"), 'transport state type is exported');
    assert.ok(hook.includes('onTransport?: (state: CodeTransportState) => void'), 'hook accepts an onTransport callback');
    assert.ok(hook.includes("onTransportRef.current?.('connected')"), 'onopen reports connected/recovered');
    assert.ok(hook.includes('es.readyState === EventSource.CLOSED') && hook.includes("'disconnected'") && hook.includes("'reconnecting'"), 'onerror maps readyState to disconnected/reconnecting');
});

test('transport status renders in a polite live region, separate from child recovery', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const workbench = read('public/manager/src/code/CodeWorkbench.tsx');
    assert.ok(canvas.includes('const [transportState, setTransportState]'), 'CodeCanvas owns transport state');
    assert.ok(canvas.includes('onTransport: setTransportState'), 'CodeCanvas feeds transport state from the hook');
    assert.ok(workbench.includes("props.transportState !== 'connected'"), 'status strip shows only when not connected');
    assert.ok(workbench.includes('code-transport-status') && workbench.includes('role="status"') && workbench.includes('aria-live="polite"'), 'transport status uses a polite live region');
    // Kept separate from the existing child ACP recovery banner.
    assert.ok(workbench.includes('code-child-recovery'), 'child recovery banner remains distinct');
});
