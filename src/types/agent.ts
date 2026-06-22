// ─── Agent Context Types ─────────────────────────────
// Shared type definitions for agent spawn context objects.

import type { WatchdogHandle } from '../agent/watchdog.js';

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

/** Context object created per spawnAgent() invocation. */
export interface SpawnContext {
  fullText: string;
  traceLog: string[];
  toolLog: ToolEntry[];
  seenToolKeys: Set<string>;
  hasClaudeStreamEvents: boolean;
  sessionId: string | null;
  cost: number | null;
  turns: number | null;
  duration: number | null;
  tokens: Record<string, number> | null;
  stderrBuf: string;
  hasActiveSubAgent?: boolean;
  showReasoning?: boolean;
  outputTextStarted?: boolean;
  effectiveProvider?: string;
  thinkingBuf?: string;
  liveScope?: string | null;
  parentLiveScope?: string | null;
  _parentSyncedCount?: number;
  traceRunId?: string;
  traceAudience?: 'public' | 'internal';
  // Phase 3: model/metadata storage
  model?: string;
  metadata?: Record<string, unknown>;
  finishReason?: string;
  pendingOutputChunk?: string;
  geminiDeltaActive?: boolean;
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
  // Gemini watchdog flag (set on 'result' event, triggers kill timer in spawn.ts)
  geminiResultSeen?: boolean;
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
  agyFinalPlannerSeen?: boolean;
  agyFinalPlannerText?: string | undefined;
  agyLastTranscriptError?: AgyTranscriptError | undefined;
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
