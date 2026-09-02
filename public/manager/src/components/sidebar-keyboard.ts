export const INSTANCE_JUMP_HINT_SHOW_DELAY_MS = 200;
export const SETTLED_TAIL_INITIAL_COUNT = 10;
export const SETTLED_TAIL_PAGE_COUNT = 25;

export type TraverseDir = 'previous' | 'next';
export type InstanceJumpSelector = (port: number) => void;

export function resolveAdjacentPort(list: readonly number[], current: number | null, dir: TraverseDir): number | null {
    if (list.length === 0) return null;
    if (current == null) return dir === 'previous' ? (list[list.length - 1] ?? null) : (list[0] ?? null);
    const idx = list.indexOf(current);
    if (idx === -1) return null;
    if (dir === 'previous') return idx > 0 ? (list[idx - 1] ?? null) : null;
    return idx < list.length - 1 ? (list[idx + 1] ?? null) : null;
}

export function jumpInstanceIndexFromAction(action: string): number | null {
    const match = /^jumpInstance([1-9])$/.exec(action);
    return match ? Number(match[1]!) - 1 : null;
}

export function isSettledStatus(status: string): boolean {
    return status === 'offline' || status === 'unknown' || status === 'timeout';
}

export function pageSettledPorts(settledPorts: readonly number[], visibleCount: number, selectedPort: number | null): number[] {
    const visible = settledPorts.slice(0, Math.max(0, visibleCount));
    if (selectedPort != null && settledPorts.includes(selectedPort) && !visible.includes(selectedPort)) {
        return [...visible, selectedPort];
    }
    return visible;
}

export function createJumpHintVisibilityController(input: {
    delayMs: number;
    onVisibilityChange: (visible: boolean) => void;
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
}): { sync: (shouldShow: boolean) => void; dispose: () => void } {
    const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;
    let isVisible = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const clearPending = (): void => {
        if (timeoutId == null) return;
        clearTimeoutFn(timeoutId);
        timeoutId = null;
    };
    return {
        sync(shouldShow: boolean): void {
            if (!shouldShow) {
                clearPending();
                if (isVisible) {
                    isVisible = false;
                    input.onVisibilityChange(false);
                }
                return;
            }
            if (isVisible || timeoutId != null) return;
            timeoutId = setTimeoutFn(() => {
                timeoutId = null;
                isVisible = true;
                input.onVisibilityChange(true);
            }, input.delayMs);
        },
        dispose(): void { clearPending(); },
    };
}

let jumpHintsVisible = false;
const jumpHintListeners = new Set<() => void>();

export function subscribeJumpHints(cb: () => void): () => void {
    jumpHintListeners.add(cb);
    return () => { jumpHintListeners.delete(cb); };
}

export function getJumpHintsVisible(): boolean {
    return jumpHintsVisible;
}

export function setJumpHintsVisible(next: boolean): void {
    if (jumpHintsVisible === next) return;
    jumpHintsVisible = next;
    jumpHintListeners.forEach(listener => listener());
}

export function shouldArmJumpHint(event: Pick<KeyboardEvent, 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'key'>): boolean {
    return event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
}

export function readRenderedInstancePorts(root: ParentNode): number[] {
    return Array.from(root.querySelectorAll<HTMLElement>('[data-instance-port]'))
        .map(el => Number(el.dataset['instancePort']))
        .filter(port => Number.isInteger(port));
}

export function handleInstanceListKeyDown(event: KeyboardEvent, root: ParentNode, onSelectPort: (port: number) => void): void {
    if (event.isComposing || event.keyCode === 229) return;
    const buttons = Array.from(root.querySelectorAll<HTMLElement>('[data-instance-port]'));
    if (buttons.length === 0) return;
    const ports = buttons.map(el => Number(el.dataset['instancePort']));
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const currentEl = active?.closest('[data-instance-port]');
    const currentPort = currentEl instanceof HTMLElement ? Number(currentEl.dataset['instancePort']) : null;
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = resolveAdjacentPort(ports, currentPort, 'next');
    else if (event.key === 'ArrowUp') next = resolveAdjacentPort(ports, currentPort, 'previous');
    else if (event.key === 'Home') next = ports[0] ?? null;
    else if (event.key === 'End') next = ports[ports.length - 1] ?? null;
    else if (event.key === 'Enter' && currentPort != null) {
        event.preventDefault();
        onSelectPort(currentPort);
        return;
    }
    if (next == null) return;
    event.preventDefault();
    buttons.find(el => Number(el.dataset['instancePort']) === next)?.focus();
}

let instanceJumpSelector: InstanceJumpSelector | null = null;

export function registerInstanceJumpSelector(fn: InstanceJumpSelector | null): void {
    instanceJumpSelector = fn;
}

export function getInstanceJumpSelector(): InstanceJumpSelector | null {
    return instanceJumpSelector;
}
