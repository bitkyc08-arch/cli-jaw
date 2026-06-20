import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

let allowedOrigin: string | null = null;

export function setAllowedOrigin(origin: string): void {
    allowedOrigin = origin;
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
