const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_PREVIEW_PORT_FROM = 24602;
const DEFAULT_PREVIEW_PORT_COUNT = 50;
const MAX_PREVIEW_PORT_COUNT = 200;

export interface PreviewFramePolicy {
  previewFrom: number;
  previewCount: number;
}

export interface NavigationPolicyOptions extends PreviewFramePolicy {
  managerOrigin: string;
}

function normalizeLoopbackHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function parsePositiveInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function resolvePreviewFramePolicy(env: NodeJS.ProcessEnv): PreviewFramePolicy {
  return {
    previewFrom: parsePositiveInt(env.DASHBOARD_PREVIEW_FROM, DEFAULT_PREVIEW_PORT_FROM),
    previewCount: parsePositiveInt(
      env.DASHBOARD_SCAN_COUNT,
      DEFAULT_PREVIEW_PORT_COUNT,
      MAX_PREVIEW_PORT_COUNT,
    ),
  };
}

export function buildPreviewFrameOrigins(policy: PreviewFramePolicy): string[] {
  const origins: string[] = [];
  for (let offset = 0; offset < policy.previewCount; offset++) {
    const port = policy.previewFrom + offset;
    origins.push(`http://127.0.0.1:${port}`);
    origins.push(`http://localhost:${port}`);
  }
  return origins;
}

export function buildManagerCsp(managerOrigin: string, previewFrameOrigins: string[]): string {
  const wsOrigin = managerOrigin
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:');
  const frameSrc = [`'self'`, ...previewFrameOrigins].join(' ');
  return [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self' ${managerOrigin} ${wsOrigin}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'self'`,
    `frame-src ${frameSrc}`,
    `form-action 'self'`,
  ].join('; ');
}

export function isManagerNavigation(raw: string, managerOrigin: string): boolean {
  try {
    return new URL(raw).origin === managerOrigin;
  } catch {
    return false;
  }
}

export function isPreviewFrameNavigation(raw: string, policy: PreviewFramePolicy): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:') return false;
    const host = normalizeLoopbackHost(parsed.hostname);
    if (!LOOPBACK_HOSTS.has(host)) return false;
    const port = Number(parsed.port);
    return Number.isInteger(port)
      && port >= policy.previewFrom
      && port < policy.previewFrom + policy.previewCount;
  } catch {
    return false;
  }
}
