const SAMPLE_INTERVAL_MS = 5_000;
const BUFFER_LENGTH = 60;
const METRICS_POST_PATH = '/api/dashboard/electron-metrics';
const ELECTRON_HEADER = 'x-cli-jaw-electron';

export interface RawAppMetric {
  type: string;
  name?: string;
  pid: number;
  memory?: { workingSetSize?: number };
  cpu?: { percentCPUUsage?: number };
}

export interface MetricsProcessSample {
  type: string;
  name?: string;
  pid: number;
  /** Resident set size in kilobytes (Electron's app.getAppMetrics reports KB). */
  rssKb: number;
  /** Per-process CPU usage as a percentage (0-100, multi-core may exceed 100). */
  cpu: number;
}

export interface MetricsSnapshot {
  ts: number;
  rendererCount: number;
  mainCount: number;
  /** Total RSS in kilobytes across all sampled processes. */
  rssTotalKb: number;
  processes: MetricsProcessSample[];
}

export interface MetricsCollectorHandle {
  stop(): void;
  snapshot(): MetricsSnapshot | null;
  buffer(): readonly MetricsSnapshot[];
}

type MaybePromise<T> = T | Promise<T>;

export interface AppMetricsCollectorOptions {
  sampleAppMetrics?: () => MaybePromise<readonly RawAppMetric[]>;
  now?: () => number;
  scheduleTick?: (callback: () => void, intervalMs: number) => unknown;
  clearTick?: (handle: unknown) => void;
  fetchImpl?: typeof fetch;
  managerUrlProvider: () => string;
  tokenProvider: () => string;
  intervalMs?: number;
  onError?: (error: Error) => void;
}

async function defaultSampleAppMetrics(): Promise<readonly RawAppMetric[]> {
  // Keep the factory importable in Node unit tests; Electron is loaded only by the
  // production default sampler. Tests inject sampleAppMetrics without module mocks.
  const { app } = await import('electron');
  return app.getAppMetrics();
}

function defaultScheduleTick(callback: () => void, intervalMs: number): unknown {
  return setInterval(callback, intervalMs);
}

function defaultClearTick(handle: unknown): void {
  // Timer handles are opaque at the injection boundary; the production scheduler
  // and clearer are paired, while tests may use any deterministic fake handle.
  clearInterval(handle as ReturnType<typeof setInterval>);
}

function unrefTick(handle: unknown): void {
  if (!handle || (typeof handle !== 'object' && typeof handle !== 'function')) return;
  const unref = (handle as { unref?: unknown }).unref;
  if (typeof unref === 'function') unref.call(handle);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function takeSample(raw: readonly RawAppMetric[], now: number): MetricsSnapshot {
  const processes: MetricsProcessSample[] = raw.map((metric) => ({
    type: metric.type,
    name: metric.name,
    pid: metric.pid,
    rssKb: metric.memory?.workingSetSize ?? 0,
    cpu: metric.cpu?.percentCPUUsage ?? 0,
  }));
  let rendererCount = 0;
  let mainCount = 0;
  let rssTotalKb = 0;
  for (const process of processes) {
    rssTotalKb += process.rssKb;
    if (process.type === 'Tab') rendererCount += 1;
    if (process.type === 'Browser') mainCount += 1;
  }
  return {
    ts: now,
    rendererCount,
    mainCount,
    rssTotalKb,
    processes,
  };
}

export function startAppMetricsCollector(
  options: AppMetricsCollectorOptions,
): MetricsCollectorHandle {
  const sampleAppMetrics = options.sampleAppMetrics ?? defaultSampleAppMetrics;
  const now = options.now ?? Date.now;
  const scheduleTick = options.scheduleTick ?? defaultScheduleTick;
  const clearTick = options.clearTick ?? defaultClearTick;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
  const buffer: MetricsSnapshot[] = [];
  let stopped = false;
  let tickInFlight = false;
  let requestController: AbortController | null = null;

  const runTick = async (): Promise<void> => {
    if (stopped || tickInFlight) return;
    tickInFlight = true;
    let controller: AbortController | null = null;
    try {
      const raw = await sampleAppMetrics();
      if (stopped) return;

      const snapshot = takeSample(raw, now());
      buffer.push(snapshot);
      while (buffer.length > BUFFER_LENGTH) buffer.shift();

      const managerUrl = options.managerUrlProvider().trim();
      const token = options.tokenProvider().trim();
      if (!managerUrl || !token) return;

      controller = new AbortController();
      requestController = controller;
      const response = await fetchImpl(new URL(METRICS_POST_PATH, managerUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ELECTRON_HEADER]: token,
        },
        body: JSON.stringify(snapshot),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`metrics POST failed with status ${response.status}`);
      }
    } catch (error) {
      if (!stopped) options.onError?.(asError(error));
    } finally {
      if (requestController === controller) requestController = null;
      tickInFlight = false;
    }
  };

  const tickHandle = scheduleTick(() => {
    void runTick();
  }, intervalMs);
  unrefTick(tickHandle);
  void runTick();

  const latest = (): MetricsSnapshot | null =>
    buffer.length > 0 ? buffer[buffer.length - 1] ?? null : null;

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTick(tickHandle);
      requestController?.abort();
      requestController = null;
    },
    snapshot: latest,
    buffer: () => buffer,
  };
}
