import { URL } from 'node:url';

const DASHBOARD2_PATHNAME = '/dashboard2/';

export function buildImplicitManagerUrl(port: number): string {
  const url = new URL(`http://127.0.0.1:${port}`);
  url.pathname = DASHBOARD2_PATHNAME;
  return url.toString();
}

export function resolveManagerUrl(raw: string | undefined, port: number): string {
  const explicit = raw?.trim();
  return explicit || buildImplicitManagerUrl(port);
}

export function resolveManagerRouteUrl(managerUrl: string, route: string): string {
  const base = new URL(managerUrl);
  const target = new URL(route, base.origin);
  if (target.origin !== base.origin) {
    throw new Error(`[jaw-electron] manager route must stay on ${base.origin}`);
  }

  if (base.pathname !== '/') {
    const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    const routePath = target.pathname.replace(/^\/+/, '');
    target.pathname = routePath ? `${basePath}${routePath}` : base.pathname;
  }
  return target.toString();
}
