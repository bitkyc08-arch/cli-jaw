// ─── Agent Context Types ─────────────────────────────
// Shared type definitions for agent spawn context objects.

export interface ToolEntry {
  icon: string;
  rawIcon?: string;
  label: string;
  toolType: string;
  detail?: string;
  stepRef?: string;
  status?: string;
  exitCode?: number;
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
  thinkingBuf?: string;
  liveScope?: string | null;
  parentLiveScope?: string | null;
  _parentSyncedCount?: number;
  // Phase 3: model/metadata storage
  model?: string;
  metadata?: Record<string, unknown>;
  finishReason?: string;
  pendingOutputChunk?: string;
  geminiDeltaActive?: boolean;
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
  acpSubagentToolCallIds?: Set<string>;
  acpSubagentLabels?: Map<string, string>;
  // Gemini watchdog flag (set on 'result' event, triggers kill timer in spawn.ts)
  geminiResultSeen?: boolean;
  // Claude-specific stream buffers (set by events.ts extractFromEvent)
  claudeThinkingBuf?: string;
  claudeInputJsonBuf?: string;
  claudeCurrentToolName?: string;
  // Encrypted-thinking detection (opus-4-7: signature_delta only, no thinking_delta)
  claudeThinkingBlockOpen?: boolean;
  claudeThinkingHadDelta?: boolean;
  claudeSignatureLen?: number;
  cliNativeCompactDetected?: boolean;
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
