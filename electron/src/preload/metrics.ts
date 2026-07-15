import { ipcRenderer } from 'electron';

const METRICS_IPC_CHANNEL = 'cli-jaw:metrics:get-latest';
const POST_PATH = '/api/dashboard/electron-metrics';
const POLL_INTERVAL_MS = 5000;

interface MetricsProcessSample {
  type: string;
  name?: string;
  pid: number;
  rssKb: number;
  cpu: number;
}

interface MetricsSnapshot {
  ts: number;
  rendererCount: number;
  mainCount: number;
  rssTotalKb: number;
  processes: MetricsProcessSample[];
}

let latest: MetricsSnapshot | null = null;
let started = false;

async function pullAndPost(): Promise<void> {
  let snap: MetricsSnapshot | null = null;
  try {
    const result = (await ipcRenderer.invoke(METRICS_IPC_CHANNEL)) as MetricsSnapshot | null;
    snap = result ?? null;
  } catch {
    snap = null;
  }
  if (!snap) return;
  latest = snap;
  try {
    await fetch(POST_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(snap),
    });
  } catch {
    // network/route may be unavailable while manager is starting; ignore.
  }
}

export function getLatestMetrics(): MetricsSnapshot | null {
  return latest;
}

export function setupMetricsBridge(): void {
  if (started) return;
  started = true;
  // Defer first tick to allow document load.
  setTimeout(() => {
    void pullAndPost();
  }, 1000);
  const handle = setInterval(() => {
    void pullAndPost();
  }, POLL_INTERVAL_MS);
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => clearInterval(handle));
  }
}
