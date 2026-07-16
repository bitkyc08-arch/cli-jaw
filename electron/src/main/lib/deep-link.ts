import type { App, BrowserWindow } from 'electron';
import { URL } from 'node:url';
import { resolveManagerRouteUrl } from './manager-url.js';

export const JAW_PROTOCOL = 'jaw';

const ALLOWED_ACTIONS = new Set(['open']);

export type JawDeepLink = {
  action: 'open';
  path: string;
};

export type DeepLinkRouteOptions = {
  managerUrl: string;
  getWindow: () => BrowserWindow | null;
  ensureReady: () => Promise<void>;
};

export function registerJawProtocol(app: App): boolean {
  if (process.platform === 'darwin') {
    return app.setAsDefaultProtocolClient(JAW_PROTOCOL);
  }
  return app.setAsDefaultProtocolClient(JAW_PROTOCOL, process.execPath);
}

export function extractJawUrlArg(argv: string[]): string | null {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const candidate = argv[i];
    if (candidate?.startsWith(`${JAW_PROTOCOL}:`)) return candidate;
  }
  return null;
}

export function parseJawDeepLink(raw: string): JawDeepLink | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${JAW_PROTOCOL}:`) return null;
  const action = parsed.hostname || parsed.pathname.replace(/^\/+/, '').split('/')[0];
  if (!ALLOWED_ACTIONS.has(action)) return null;

  const path = parsed.searchParams.get('path');
  if (!path || !path.startsWith('/') || path.startsWith('//')) return null;
  if (path.includes('\\') || /[\u0000-\u001F\u007F]/u.test(path)) return null;

  return { action: 'open', path };
}

export function focusWindow(window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return true;
}

export async function routeJawDeepLink(
  raw: string,
  options: DeepLinkRouteOptions,
): Promise<boolean> {
  const link = parseJawDeepLink(raw);
  if (!link) return false;

  await options.ensureReady();
  const targetWindow = options.getWindow();
  if (!targetWindow || !focusWindow(targetWindow)) return false;

  const target = new URL(resolveManagerRouteUrl(options.managerUrl, link.path));
  const managerOrigin = new URL(options.managerUrl).origin;
  if (target.origin !== managerOrigin) return false;

  await targetWindow.loadURL(target.toString());
  return true;
}
