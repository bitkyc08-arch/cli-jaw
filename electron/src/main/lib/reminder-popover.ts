import { BrowserWindow, screen } from 'electron';
import type { Rectangle } from 'electron';

const POPOVER_WIDTH = 360;
const POPOVER_HEIGHT = 460;
const POPOVER_MARGIN = 8;

export interface ReminderPopover {
  toggle(anchor: Rectangle | null): void;
  hide(): void;
  destroy(): void;
}

export function createReminderPopover(opts: {
  managerUrl: string;
  managerOrigin: string;
  preloadPath: string;
}): ReminderPopover {
  let window: BrowserWindow | null = null;
  const popoverUrl = new URL('?sidebar=reminders&tray=1', opts.managerUrl).toString();

  function isAllowedNavigation(raw: string): boolean {
    try {
      return new URL(raw).origin === opts.managerOrigin;
    } catch {
      return false;
    }
  }

  function ensureWindow(): BrowserWindow {
    if (window && !window.isDestroyed()) return window;
    window = new BrowserWindow({
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
      frame: false,
      show: false,
      resizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      title: 'cli-jaw Reminders',
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: opts.preloadPath,
      },
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url)) event.preventDefault();
    });
    window.webContents.on('will-redirect', (event, url) => {
      if (!isAllowedNavigation(url)) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => (
      isAllowedNavigation(url) ? { action: 'allow' } : { action: 'deny' }
    ));
    window.on('blur', () => {
      if (window && !window.isDestroyed()) window.hide();
    });
    window.on('closed', () => {
      window = null;
    });
    void window.loadURL(popoverUrl);
    return window;
  }

  function positionWindow(target: BrowserWindow, anchor: Rectangle | null): void {
    const anchorCenter = anchor
      ? { x: Math.round(anchor.x + anchor.width / 2), y: Math.round(anchor.y + anchor.height / 2) }
      : null;
    const display = anchorCenter
      ? screen.getDisplayNearestPoint(anchorCenter)
      : screen.getPrimaryDisplay();
    const { workArea } = display;
    const desiredX = anchor
      ? Math.round(anchor.x + anchor.width / 2 - POPOVER_WIDTH / 2)
      : Math.round(workArea.x + workArea.width - POPOVER_WIDTH - POPOVER_MARGIN);
    const belowY = anchor ? anchor.y + anchor.height + POPOVER_MARGIN : workArea.y + POPOVER_MARGIN;
    const aboveY = anchor ? anchor.y - POPOVER_HEIGHT - POPOVER_MARGIN : belowY;
    const desiredY = belowY + POPOVER_HEIGHT <= workArea.y + workArea.height ? belowY : aboveY;
    const x = Math.min(
      Math.max(desiredX, workArea.x + POPOVER_MARGIN),
      workArea.x + workArea.width - POPOVER_WIDTH - POPOVER_MARGIN,
    );
    const y = Math.min(
      Math.max(desiredY, workArea.y + POPOVER_MARGIN),
      workArea.y + workArea.height - POPOVER_HEIGHT - POPOVER_MARGIN,
    );
    target.setBounds({ x, y, width: POPOVER_WIDTH, height: POPOVER_HEIGHT });
  }

  return {
    toggle(anchor) {
      const target = ensureWindow();
      if (target.isVisible()) {
        target.hide();
        return;
      }
      positionWindow(target, anchor);
      target.show();
      target.focus();
    },
    hide() {
      if (window && !window.isDestroyed()) window.hide();
    },
    destroy() {
      if (!window || window.isDestroyed()) return;
      window.destroy();
      window = null;
    },
  };
}
