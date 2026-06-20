import { Tray, Menu, nativeImage, app, clipboard, Notification, dialog } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isCliInstalled, installCli } from './install-cli.js';

const PREFS_FILENAME = 'tray-preferences.json';

interface TrayPrefs {
  keepRunningInBackground: boolean;
  startAtLogin: boolean;
}

const DEFAULT_PREFS: TrayPrefs = {
  keepRunningInBackground: false,
  startAtLogin: false,
};

let prefs: TrayPrefs = { ...DEFAULT_PREFS };

function prefsPath(): string {
  return join(app.getPath('userData'), PREFS_FILENAME);
}

function loadPrefs(): void {
  try {
    if (existsSync(prefsPath())) {
      const data = JSON.parse(readFileSync(prefsPath(), 'utf8'));
      prefs = {
        keepRunningInBackground: data.keepRunningInBackground === true,
        startAtLogin: data.startAtLogin === true,
      };
    }
  } catch { /* ignore corrupt file */ }
}

function savePrefs(): void {
  try {
    writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2));
  } catch { /* ignore */ }
}

let tray: Tray | null = null;
let callbacks: TrayCallbacks | null = null;
let serverStatus = 'Starting...';
let currentMenu: Menu | null = null;
let onTrayClick: (() => void) | null = null;

export interface TrayCallbacks {
  onOpenDashboard: () => void;
  onRestartServer: () => void;
  onQuit: () => void;
  getManagerUrl: () => string;
}

export function isKeepRunning(): boolean {
  return prefs.keepRunningInBackground;
}

export function createTray(cb: TrayCallbacks): Tray {
  loadPrefs();
  callbacks = cb;
  syncLoginItemSetting();

  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'trayTemplate.png')
    : join(__dirname, '..', '..', 'build', 'trayTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('cli-jaw');
  rebuildMenu();
  tray.on('click', () => (onTrayClick ? onTrayClick() : cb.onOpenDashboard()));
  tray.on('right-click', () => popUpTrayMenu());
  return tray;
}

export function updateServerStatus(status: string): void {
  serverStatus = status;
  rebuildMenu();
}

export function setTrayBadge(count: number): void {
  if (!tray) return;
  tray.setTitle(count > 0 ? ` ${count}` : '');
}

export function notifyServerCrash(): void {
  setTrayBadge(1);
  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'cli-jaw',
      body: 'Server crashed. Use Restart Server from the menu bar.',
      silent: false,
    });
    n.show();
  }
}

export function clearTrayBadge(): void {
  setTrayBadge(0);
}

export function setTrayClickHandler(fn: () => void): void {
  onTrayClick = fn;
}

export function popUpTrayMenu(): void {
  if (tray && currentMenu) tray.popUpContextMenu(currentMenu);
}

export function getTrayBoundsSafe(): Electron.Rectangle | null {
  return tray?.getBounds() ?? null;
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
  callbacks = null;
  currentMenu = null;
  onTrayClick = null;
}

function syncLoginItemSetting(): void {
  app.setLoginItemSettings({
    openAtLogin: prefs.startAtLogin,
    args: prefs.startAtLogin ? ['--background'] : [],
  });
}

function rebuildMenu(): void {
  if (!tray || !callbacks) return;
  const cb = callbacks;
  const menu = Menu.buildFromTemplate([
    { label: serverStatus, enabled: false },
    { type: 'separator' },
    {
      label: 'Open Dashboard',
      click: cb.onOpenDashboard,
    },
    {
      label: 'Copy URL',
      click: () => clipboard.writeText(cb.getManagerUrl()),
    },
    {
      label: 'Restart Server',
      click: cb.onRestartServer,
    },
    { type: 'separator' },
    {
      label: 'Keep Running in Background',
      type: 'checkbox',
      checked: prefs.keepRunningInBackground,
      click: (item) => {
        prefs.keepRunningInBackground = item.checked;
        savePrefs();
      },
    },
    {
      label: 'Start at Login',
      type: 'checkbox',
      checked: prefs.startAtLogin,
      click: (item) => {
        prefs.startAtLogin = item.checked;
        savePrefs();
        syncLoginItemSetting();
      },
    },
    {
      label: isCliInstalled() ? 'CLI Installed ✓' : 'Install CLI to Terminal',
      enabled: app.isPackaged && !isCliInstalled(),
      click: async () => {
        const result = await installCli();
        await dialog.showMessageBox({
          type: result.ok ? 'info' : 'error',
          message: result.ok ? 'CLI Installed' : 'Installation Failed',
          detail: result.message,
        });
        if (result.ok) rebuildMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quit cli-jaw', click: cb.onQuit },
  ]);
  currentMenu = menu;
}
