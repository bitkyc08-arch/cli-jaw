import { ipcMain } from 'electron';
import { isManagerSender } from '../ipc-origin-guard.js';
import { getLastElectronPermissionDenials } from '../electron-permissions.js';

export function registerPermissionDiagnosticsIpc(): void {
  ipcMain.handle('permissions:getLastDenials', (event) => {
    if (!isManagerSender(event)) return { ok: false, error: 'unauthorized' };
    return { ok: true, denials: getLastElectronPermissionDenials() };
  });
}
