import { URL } from 'node:url';
import { resolveManagerUrl } from './manager-url.js';

export interface CliFlags {
  port: number;
  attachOnly: boolean;
  spawn: boolean;
  background: boolean;
  managerUrl: string;
  managerUrlExplicit: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function assertLoopbackManagerUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`[jaw-electron] invalid manager URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `[jaw-electron] manager URL must use http: or https:. Got: ${parsed.protocol}`,
    );
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `[jaw-electron] manager URL must be loopback (127.0.0.1, localhost, ::1). Got: ${parsed.hostname}`,
    );
  }
}

export function parseCliFlags(argv: string[], defaultManagerPort: number): CliFlags {
  let port = Number(process.env.JAW_MANAGER_PORT ?? defaultManagerPort);
  let attachOnly = false;
  let spawn = false;
  let background = false;
  let managerUrl = process.env.JAW_MANAGER_URL ?? '';
  let managerUrlExplicit = managerUrl.trim().length > 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      const v = argv[++i];
      if (v) port = Number(v);
    } else if (a?.startsWith('--port=')) {
      port = Number(a.slice('--port='.length));
    } else if (a === '--attach-only') {
      attachOnly = true;
    } else if (a === '--spawn') {
      spawn = true;
    } else if (a === '--manager-url') {
      const v = argv[++i];
      if (v) {
        managerUrl = v;
        managerUrlExplicit = true;
      }
    } else if (a?.startsWith('--manager-url=')) {
      managerUrl = a.slice('--manager-url='.length);
      managerUrlExplicit = managerUrl.trim().length > 0;
    } else if (a === '--background') {
      background = true;
    }
  }
  if (!Number.isFinite(port) || port <= 0) port = defaultManagerPort;
  managerUrl = resolveManagerUrl(managerUrl, port);
  assertLoopbackManagerUrl(managerUrl);
  return { port, attachOnly, spawn, background, managerUrl, managerUrlExplicit };
}
