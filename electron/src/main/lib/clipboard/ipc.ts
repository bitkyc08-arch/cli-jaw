import { clipboard, ipcMain } from 'electron';
import { isManagerSender } from '../ipc-origin-guard.js';

const CLIPBOARD_TEXT_LIMIT = 1_000_000;

export function registerClipboardIpc(): void {
  ipcMain.handle('clipboard:writeText', (event, text: unknown) => {
    if (!isManagerSender(event)) return { ok: false, error: 'unauthorized' };
    if (typeof text !== 'string') return { ok: false, error: 'text must be a string' };
    clipboard.writeText(text.slice(0, CLIPBOARD_TEXT_LIMIT));
    return { ok: true };
  });
}
