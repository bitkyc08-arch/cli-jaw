// ─── Agent Context Types ─────────────────────────────
// Shared type definitions for agent spawn context objects.

export interface ToolEntry {
  icon: string;
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
  thinkingBuf?: string;
  liveScope?: string;
  // Phase 3: model/metadata storage
  model?: string;
  metadata?: Record<string, any>;
  finishReason?: string;
  pendingOutputChunk?: string;
  opencodeStepText?: string;
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
}
