import { BrowserWindow, ipcMain } from 'electron';
import { isManagerSender } from '../ipc-origin-guard.js';

/**
 * Window-level reload IPC. The renderer decides focus-aware behavior
 * (browser tab / preview / app window) and calls these for the app-window case.
 * Guarded by isAllowedSender so only the trusted manager origin can trigger it.
 */
export function registerWindowIpc(): void {
    ipcMain.handle('window:reload', (event) => {
        if (!isManagerSender(event)) return;
        BrowserWindow.fromWebContents(event.sender)?.webContents.reload();
    });
    ipcMain.handle('window:hardReload', (event) => {
        if (!isManagerSender(event)) return;
        BrowserWindow.fromWebContents(event.sender)?.webContents.reloadIgnoringCache();
    });
}
