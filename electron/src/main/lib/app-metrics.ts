import { app, ipcMain } from 'electron';

export const METRICS_IPC_CHANNEL = 'cli-jaw:metrics:get-latest';
const SAMPLE_INTERVAL_MS = 5000;
const BUFFER_LENGTH = 60;

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

function takeSample(): MetricsSnapshot {
  const raw = app.getAppMetrics();
  const processes: MetricsProcessSample[] = raw.map((m) => ({
    type: m.type,
    name: m.name,
    pid: m.pid,
    rssKb: m.memory?.workingSetSize ?? 0,
    cpu: m.cpu?.percentCPUUsage ?? 0,
  }));
  let rendererCount = 0;
  let mainCount = 0;
  let rssTotalKb = 0;
  for (const p of processes) {
    rssTotalKb += p.rssKb;
    if (p.type === 'Tab') rendererCount += 1;
    if (p.type === 'Browser') mainCount += 1;
  }
  return {
    ts: Date.now(),
    rendererCount,
    mainCount,
    rssTotalKb,
    processes,
  };
}

export function startAppMetricsCollector(): MetricsCollectorHandle {
  const buffer: MetricsSnapshot[] = [];

  function pushSample(): void {
    try {
      const snap = takeSample();
      buffer.push(snap);
      while (buffer.length > BUFFER_LENGTH) buffer.shift();
    } catch {
      // app.getAppMetrics can throw before app is ready; ignore.
    }
  }

  pushSample();
  const handle = setInterval(pushSample, SAMPLE_INTERVAL_MS);
  // Don't keep the event loop alive on this timer alone.
  if (typeof handle.unref === 'function') handle.unref();

  const latest = (): MetricsSnapshot | null =>
    buffer.length > 0 ? buffer[buffer.length - 1] ?? null : null;

  // handle() throws if the channel is still registered, and the caller only
  // logs, so a stale handler would silently kill metrics. Clear it first.
  try {
    ipcMain.removeHandler(METRICS_IPC_CHANNEL);
  } catch {
    // nothing registered
  }
  ipcMain.handle(METRICS_IPC_CHANNEL, () => latest());

  return {
    stop(): void {
      clearInterval(handle);
      try {
        ipcMain.removeHandler(METRICS_IPC_CHANNEL);
      } catch {
        // already removed
      }
    },
    snapshot: latest,
    buffer: () => buffer,
  };
}
