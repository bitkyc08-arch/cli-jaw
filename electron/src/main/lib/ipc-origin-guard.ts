import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

let allowedOrigin: string | null = null;
let managerWindowId: (() => number | null) | null = null;

export function setAllowedOrigin(origin: string): void {
    allowedOrigin = origin;
}

/**
 * Registers the manager window's webContents id getter, so channels can
 * require the sender to be the Manager window itself, not just share its
 * origin.
 */
export function setManagerWindowIdGetter(getter: () => number | null): void {
    managerWindowId = getter;
}

export function isAllowedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    if (!allowedOrigin) return false;
    try {
        const frameUrl = event.senderFrame?.url;
        if (!frameUrl) return false;
        const origin = new URL(frameUrl).origin;
        return origin === allowedOrigin;
    } catch {
        return false;
    }
}

/**
 * Origin alone is not enough: other same-origin Electron surfaces (the tray
 * reminders popover) share the Manager origin and, until wp7b, the same
 * preload. Only the Manager window's own webContents may drive the sensitive
 * IPC — folder writes, git operations, terminal spawn, window and clipboard
 * control. The popover's renderer calls none of these, so tightening to the
 * manager's webContents id closes the hole without breaking it.
 */
export function isManagerSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    if (!isAllowedSender(event)) return false;
    if (!managerWindowId) return false;
    const id = managerWindowId();
    return id !== null && event.sender.id === id;
}
