export interface WaitOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const BACKOFF_MS = [200, 400, 800, 1600, 3000, 5000];

function buildHealthUrl(managerUrl: string): string {
  const u = new URL(managerUrl);
  return new URL('/api/dashboard/health', u.origin).toString();
}

async function probe(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    const linked = signal
      ? () => ctl.abort()
      : null;
    if (signal && linked) signal.addEventListener('abort', linked, { once: true });
    try {
      const res = await fetch(url, { signal: ctl.signal, method: 'GET' });
      if (!res.ok) return false;
      const json = (await res.json().catch(() => null)) as
        | { ok?: unknown; app?: unknown; service?: unknown }
        | null;
      return (
        !!json &&
        json.ok === true &&
        json.app === 'cli-jaw' &&
        json.service === 'manager-dashboard'
      );
    } finally {
      clearTimeout(timer);
      if (signal && linked) signal.removeEventListener('abort', linked);
    }
  } catch {
    return false;
  }
}

export async function waitForManagerReady(
  managerUrl: string,
  opts: WaitOpts = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const url = buildHealthUrl(managerUrl);
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return false;
    if (await probe(url, opts.signal)) return true;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    attempt += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      const signal = opts.signal;
      // `{ once: true }` only detaches the listener when abort actually fires.
      // When the timeout wins instead, it stays attached to a long-lived
      // signal — one stranded closure per backoff iteration. Settle once and
      // clean up both sides on whichever path wins.
      let settled = false;
      const abortHandler = () => finish();
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        if (signal) signal.removeEventListener('abort', abortHandler);
        resolve();
      };
      const t = setTimeout(finish, Math.min(delay, remaining));
      if (signal) signal.addEventListener('abort', abortHandler, { once: true });
    });
  }
  return probe(url, opts.signal);
}

export async function isManagerHealthy(managerUrl: string): Promise<boolean> {
  return probe(buildHealthUrl(managerUrl));
}

export async function probeOnce(managerUrl: string, signal?: AbortSignal): Promise<boolean> {
  return probe(buildHealthUrl(managerUrl), signal);
}
