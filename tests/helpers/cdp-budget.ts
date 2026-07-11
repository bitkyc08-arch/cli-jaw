/// <reference types="node" />

import type { CDPSession, Page } from 'playwright-core';

export interface DomCounterSample {
  documents: number;
  nodes: number;
  jsEventListeners: number;
}

export interface HeapSample {
  usedSizeBytes: number;
  totalSizeBytes: number;
}

export interface FrameBudgetReport {
  samples: number;
  p95Ms: number;
  maxMs: number;
}

export interface AnchorDriftReport {
  steps: number;
  perStepMaxPx: number;
  cumulativeDriftPx: number;
}

export interface CdpBudgetReport {
  dom: DomCounterSample;
  heap: HeapSample;
}

let rafSamplerSequence = 0;

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Samples CDP DOM counters and returns the median of each field. */
export async function sampleDomCountersMedian(
  session: CDPSession,
  sampleCount = 3,
): Promise<DomCounterSample> {
  assertPositiveInteger(sampleCount, 'sampleCount');

  const samples: DomCounterSample[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = await session.send('Memory.getDOMCounters') as DomCounterSample;
    samples.push(sample);
  }

  return {
    documents: median(samples.map((sample) => sample.documents)),
    nodes: median(samples.map((sample) => sample.nodes)),
    jsEventListeners: median(samples.map((sample) => sample.jsEventListeners)),
  };
}

/** Forces garbage collection and returns median heap usage from three samples. */
export async function collectHeapUsagePostGc(session: CDPSession): Promise<HeapSample> {
  await session.send('HeapProfiler.collectGarbage');

  const samples: Array<{ usedSize: number; totalSize: number }> = [];
  for (let index = 0; index < 3; index += 1) {
    const sample = await session.send('Runtime.getHeapUsage') as {
      usedSize: number;
      totalSize: number;
    };
    samples.push(sample);
  }

  return {
    usedSizeBytes: median(samples.map((sample) => sample.usedSize)),
    totalSizeBytes: median(samples.map((sample) => sample.totalSize)),
  };
}

/** Measures requestAnimationFrame deltas while invoking an optional streaming tick. */
export async function measureFrameDeltas(
  page: Page,
  opts: {
    hz: number;
    durationMs: number;
    onTick?: (tickIndex: number) => Promise<void> | void;
  },
): Promise<FrameBudgetReport> {
  if (!Number.isFinite(opts.hz) || opts.hz <= 0) {
    throw new RangeError('hz must be greater than zero');
  }
  if (!Number.isFinite(opts.durationMs) || opts.durationMs < 0) {
    throw new RangeError('durationMs must be non-negative');
  }

  const samplerKey = `__cliJawCdpBudgetRaf_${Date.now()}_${rafSamplerSequence += 1}`;
  await page.evaluate((key) => {
    const state = { deltas: [] as number[], frameId: 0, previous: undefined as number | undefined };
    const sample = (timestamp: number): void => {
      if (state.previous !== undefined) state.deltas.push(timestamp - state.previous);
      state.previous = timestamp;
      state.frameId = requestAnimationFrame(sample);
    };
    state.frameId = requestAnimationFrame(sample);
    (globalThis as Record<string, unknown>)[key] = state;
  }, samplerKey);

  let deltas: number[] = [];
  try {
    const startedAt = performance.now();
    const deadline = startedAt + opts.durationMs;
    const intervalMs = 1_000 / opts.hz;
    let tickIndex = 0;
    while (performance.now() < deadline) {
      const nextTickAt = startedAt + (tickIndex + 1) * intervalMs;
      const wakeAt = Math.min(nextTickAt, deadline);
      const delayMs = wakeAt - performance.now();
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (performance.now() >= deadline) break;
      await opts.onTick?.(tickIndex);
      tickIndex += 1;
    }
  } finally {
    deltas = await page.evaluate((key) => {
      const store = globalThis as Record<string, unknown>;
      const state = store[key] as { deltas: number[]; frameId: number } | undefined;
      if (!state) return [];
      cancelAnimationFrame(state.frameId);
      delete store[key];
      return state.deltas;
    }, samplerKey);
  }

  if (deltas.length === 0) return { samples: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...deltas].sort((a, b) => a - b);
  const p95Index = Math.ceil(0.95 * sorted.length) - 1;
  return {
    samples: deltas.length,
    p95Ms: sorted[p95Index],
    maxMs: sorted[sorted.length - 1],
  };
}

/** Measures per-step and cumulative top-position drift while prepending content. */
export async function measurePrependAnchor(
  page: Page,
  opts: {
    steps: number;
    anchorSelector: string;
    prepend: (step: number) => Promise<void>;
    settleFrames?: number;
  },
): Promise<AnchorDriftReport> {
  if (!Number.isInteger(opts.steps) || opts.steps < 0) {
    throw new RangeError('steps must be a non-negative integer');
  }
  const settleFrames = opts.settleFrames ?? 2;
  if (!Number.isInteger(settleFrames) || settleFrames < 0) {
    throw new RangeError('settleFrames must be a non-negative integer');
  }

  const readTop = async (): Promise<number> => {
    const top = await page.evaluate((selector) =>
      document.querySelector(selector)?.getBoundingClientRect().top ?? null,
    opts.anchorSelector);
    if (top === null) throw new Error(`Anchor not found: ${opts.anchorSelector}`);
    return top;
  };

  let perStepMaxPx = 0;
  let cumulativeDriftPx = 0;
  for (let step = 0; step < opts.steps; step += 1) {
    const beforeTop = await readTop();
    await opts.prepend(step);
    await page.evaluate(async (frames) => {
      for (let frame = 0; frame < frames; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    }, settleFrames);
    const delta = (await readTop()) - beforeTop;
    perStepMaxPx = Math.max(perStepMaxPx, Math.abs(delta));
    cumulativeDriftPx += delta;
  }

  return {
    steps: opts.steps,
    perStepMaxPx,
    cumulativeDriftPx: Math.abs(cumulativeDriftPx),
  };
}

/** Collects the shared DOM and post-GC heap budget envelope. */
export async function collectCdpBudget(
  session: CDPSession,
  opts: { domSampleCount?: number } = {},
): Promise<CdpBudgetReport> {
  const dom = await sampleDomCountersMedian(session, opts.domSampleCount);
  const heap = await collectHeapUsagePostGc(session);
  return { dom, heap };
}
