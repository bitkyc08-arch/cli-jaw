// ─── Agent Context Types ─────────────────────────────
// Shared type definitions for agent spawn context objects.

import type { WatchdogHandle } from '../agent/watchdog.js';
import type { TracePointer } from '../trace/types.js';

export interface ToolEntry {
  icon: string;
  rawIcon?: string;
  label: string;
  toolType: string;
  detail?: string;
  stepRef?: string;
  status?: string;
  exitCode?: number;
  isEmployee?: boolean;
  traceRunId?: string;
  traceSeq?: number;
  detailAvailable?: boolean;
  detailBytes?: number;
  rawRetentionStatus?: string;
}

export interface AgyTranscriptError {
  message: string;
  code?: string | number;
  createdAtMs?: number;
}

export type AgyBootstrapAcceptanceMode =
  | 'pending'
  | 'accepted'
  | 'missing'
  | 'not-applicable';

export type AgyTranscriptMode =
  | 'not-started'
  | 'anchored'
  | 'bootstrap-missing'
  | 'fallback-missing'
  | 'fallback-timeout'
  | 'provider-error';

export type AgyLastActivitySource = 'stdout' | 'stderr' | 'transcript' | 'none';

/** Context object created per spawnAgent() invocation. */
export interface SpawnContext {
  fullText: string;
  traceLog: string[];
  toolLog: ToolEntry[];
  seenToolKeys: Set<string>;
  hasClaudeStreamEvents: boolean;
  /** Per-message guard: plain `claude` text_delta streamed prose live this message,
   *  so handleClaudeEvent skips the duplicate complete-block append and resets it.
   *  Distinct from run-level hasClaudeStreamEvents (set by ANY content_block_start,
   *  incl tool_use) — that would false-skip a tool-only turn whose prose arrives
   *  only in the complete assistant event. */
  claudeStreamedText?: boolean;
  /** Wall-clock run start; rides on agent_tool broadcasts so the web UI's elapsed
   * timer has one authoritative origin (WP3, zero-seconds bug). */
  runStartedAt?: number;
  /** Stream-target offset where the current message's raw text deltas began —
   * consumed by the complete-block reconcile in handleClaudeEvent. */
  claudeStreamedTextStart?: number | undefined;
  sessionId: string | null;
  cost: number | null;
  turns: number | null;
  duration: number | null;
  tokens: Record<string, number> | null;
  stderrBuf: string;
  hasActiveSubAgent?: boolean;
  showReasoning?: boolean;
  outputTextStarted?: boolean;
  /** Selected CLI before provider-specific parsing; used by turn fidelity normalization. */
  runtimeCli?: string;
  effectiveProvider?: string;
  thinkingBuf?: string;
  liveScope?: string | null;
  parentLiveScope?: string | null;
  _parentSyncedCount?: number;
  traceRunId?: string;
  traceAudience?: 'public' | 'internal';
  /** stepRef → trace pointer, populated at stamp time, so completion handlers can
   *  converge the durable tool row even after the RAM cap evicted the entry
   *  (WP4, devlog 260703 doc 12). */
  toolTraceIndex?: Map<string, TracePointer>;
  // Phase 3: model/metadata storage
  model?: string;
  metadata?: Record<string, unknown>;
  finishReason?: string;
  pendingOutputChunk?: string;
  grokThoughtBuf?: string;
  grokCurrentThoughtRef?: string;
  grokThoughtSeq?: number;
  grokLastThoughtEmitAt?: number;
  grokLastThoughtEmitChars?: number;
  grokThoughtProgressEmitted?: boolean;
  grokSyntheticToolSeq?: number;
  opencodePreToolText?: string;
  opencodePostToolText?: string;
  opencodeSawToolInStep?: boolean;
  opencodeHadToolErrorInStep?: boolean;
  opencodePendingToolRefs?: string[];
  opencodeTaskCallIds?: Set<string>;
  opencodeStepThinkingToolEmitted?: boolean;
  opencodeRawEvents?: string[];
  opencodeLastEventType?: string;
  opencodeLastEventAt?: number;
  opencodeSpawnAudit?: Record<string, unknown>;
  cursorAssistantText?: string;
  cursorAssistantSeq?: number;
  cursorToolCallIds?: Set<string>;
  acpSubagentToolCallIds?: Set<string>;
  acpSubagentLabels?: Map<string, string>;
  // Claude-specific stream buffers (set by events.ts extractFromEvent)
  claudeThinkingBuf?: string;
  claudeInputJsonBuf?: string;
  claudeCurrentToolName?: string;
  claudeILastAssistantId?: string;
  claudeILastAssistantText?: string;
  claudeRateLimitEventSeen?: boolean;
  // Encrypted-thinking detection (opus-4-7: signature_delta only, no thinking_delta)
  claudeThinkingBlockOpen?: boolean;
  claudeThinkingHadDelta?: boolean;
  claudeSignatureLen?: number;
  cliNativeCompactDetected?: boolean;
  stallReason?: string;
  stallWatchdog?: WatchdogHandle;
  agyResumeOffset?: number;
  agyBytesReceived?: number;
  agyTranscriptActive?: boolean;
  agyTranscriptMode?: AgyTranscriptMode;
  agyTranscriptLastReason?: string;
  agyLastActivitySource?: AgyLastActivitySource;
  agyBootstrapSentinel?: string;
  agyBootstrapHash?: string;
  agyBootstrapAccepted?: boolean;
  agyBootstrapAcceptanceMode?: AgyBootstrapAcceptanceMode;
  agyFinalPlannerSeen?: boolean;
  agyFinalPlannerText?: string | undefined;
  agyLastTranscriptError?: AgyTranscriptError | undefined;
  /** Set when agy stdout accumulation hit AGY_FULLTEXT_MAX_CHARS (explicit, not silent). */
  agyFullTextTruncated?: boolean;
  kiroDisplayedText?: string;
  kiroLineBuffer?: string;
  kiroToolSeq?: number;
  kiroActiveToolRef?: string | null;
  kiroActiveToolLabel?: string | null;
  kiroLastVisibleAt?: number;
  kiroHeartbeatSent?: boolean;
  /** Formatted assistant preview text; raw CLI stdout may live separately in fullText. */
  liveOutputText?: string;
  scheduleWakeup?: {
    delaySeconds: number;
    prompt: string;
    reason: string;
  };
}

export interface SpawnResult {
  text: string;
  code: number;
  sessionId?: string | null;
  tools?: ToolEntry[];
  cost?: number | null;
  smoke?: string | null;
  diagnostic?: string;
}
