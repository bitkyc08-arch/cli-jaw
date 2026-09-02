import { BrowserWindow, ipcMain } from 'electron';
import { isAllowedSender } from '../ipc-origin-guard.js';

/**
 * Window-level reload IPC. The renderer decides focus-aware behavior
 * (browser tab / preview / app window) and calls these for the app-window case.
 * Guarded by isAllowedSender so only the trusted manager origin can trigger it.
 */
export function registerWindowIpc(): void {
    ipcMain.handle('window:reload', (event) => {
        if (!isAllowedSender(event)) return;
        BrowserWindow.fromWebContents(event.sender)?.webContents.reload();
    });
    ipcMain.handle('window:hardReload', (event) => {
        if (!isAllowedSender(event)) return;
        BrowserWindow.fromWebContents(event.sender)?.webContents.reloadIgnoringCache();
    });
    ipcMain.handle('window:get-fullscreen', (event) => {
        if (!isAllowedSender(event)) return false;
        return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() === true;
    });
}

export function broadcastFullscreenChanged(win: BrowserWindow, isFullscreen: boolean): void {
    if (win.isDestroyed()) return;
    win.webContents.send('window:fullscreen-changed', isFullscreen === true);
}
