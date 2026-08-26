import type { CliEngine } from './cli-engine.js';
import type { ToolEntry } from './agent.js';

export type CliEventEngine = CliEngine;

export interface TokenRecord extends Record<string, unknown> {
  input?: number;
  output?: number;
  read?: number;
  write?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cached?: number;
  total_tokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  tool_calls?: number;
  duration_ms?: number;
  reasoning?: number;
  total?: number;
  cache?: TokenRecord;
}

export interface CliEventRecord extends Record<string, unknown> {
  cli?: CliEventEngine;
  type?: string;
  subtype?: string;
  status?: string;
  role?: string;
  id?: string;
  name?: string;
  tool?: string;
  tool_name?: string;
  tool_id?: string;
  tool_use_id?: string;
  toolCallId?: string;
  callID?: string;
  title?: string;
  label?: string;
  text?: string;
  data?: string;
  content?: string | CliEventRecord | CliEventRecord[];
  description?: string;
  summary?: string;
  output_file?: string;
  prompt?: string;
  command?: string;
  cmd?: string;
  query?: string;
  url?: string;
  output?: string;
  aggregated_output?: string;
  error?: CliEventRecord;
  message?: CliEventRecord & { content?: CliEventRecord[] };
  event?: CliEventRecord;
  delta?: CliEventRecord;
  content_block?: CliEventRecord;
  item?: CliEventRecord;
  part?: CliEventRecord;
  action?: CliEventRecord;
  input?: CliEventRecord;
  rawInput?: CliEventRecord;
  parameters?: CliEventRecord;
  state?: CliEventRecord;
  metadata?: CliEventRecord;
  model?: string;
  usage?: TokenRecord;
  stats?: TokenRecord;
  tokens?: TokenRecord;
  cache?: TokenRecord;
  session_id?: string;
  thread_id?: string;
  sessionID?: string;
  sessionId?: string;
  requestId?: string;
  stopReason?: string;
  task_id?: string;
  task_type?: string;
  compact_boundary?: boolean;
  thought?: boolean | string;
  thinking?: string;
  partial_json?: string;
  signature?: string;
  exit_code?: number;
  cost?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  receiver_thread_ids?: string[];
  agents_states?: unknown;
  sessionUpdate?: string;
  permission?: string;
  scope?: string;
  reason?: string;
  agentDisplayName?: string;
  agentName?: string;
  tools?: unknown;
  mcp_servers?: unknown;
  version?: string;
}

export type CliEvent = CliEventRecord;

export interface AcpUpdateParams {
  update?: CliEventRecord;
}

export type AcpSubagentEvent = CliEventRecord & {
  data?: CliEventRecord & {
    tools?: string[];
  };
};

export type ExtractedEventResult =
  | { text?: string; tool?: ToolEntry; messageId?: string }
  | null;

export function isCliEventRecord(value: unknown): value is CliEventRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asCliEventRecord(value: unknown): CliEventRecord {
  return isCliEventRecord(value) ? value : {};
}

export function asCliEventArray(value: unknown): CliEventRecord[] {
  return Array.isArray(value) ? value.filter(isCliEventRecord) : [];
}

export function fieldString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function fieldNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled CLI event: ${JSON.stringify(value)}`);
}

export function discriminate(cli: string, raw: unknown): CliEvent | null {
  if (!isCliEventRecord(raw)) return null;
  if (cli === 'claude' || cli === 'claude-e' || cli === 'codex' || cli === 'cursor' || cli === 'grok' || cli === 'opencode' || cli === 'copilot') {
    return { ...raw, cli };
  }
  return null;
}
