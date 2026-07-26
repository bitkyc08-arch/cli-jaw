/**
 * The reminders popover's preload.
 *
 * It exposes ONLY the two tray actions the popover's own UI calls
 * (TrayRemindersApp.tsx): popUpMenu for the menu button and openDashboard for
 * Open Dashboard. Everything else the Manager preload opens — folder writes,
 * git operations, terminal spawn, browser control — stays closed to this
 * window. The reminders themselves load over REST fetch, so the popover needs
 * nothing more.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cliJawDesktop', {
    trayReminders: {
        popUpMenu: () => ipcRenderer.send('tray:popup-menu'),
        openDashboard: () => ipcRenderer.send('tray:open-dashboard'),
    },
});
