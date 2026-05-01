// ─── Claude Model Normalization (single source of truth) ──────────

export const CLAUDE_CANONICAL_MODELS = [
  'opus',
  'sonnet',
  'sonnet[1m]',
  'haiku',
] as const;

export type ClaudeCanonicalModel = (typeof CLAUDE_CANONICAL_MODELS)[number];

// Pinned full IDs Claude Code accepts as `--model`. The `[1m]` suffix is
// parsed by Claude Code itself (not Anthropic): the CLI strips the suffix
// before forwarding the clean model ID and enables the 1M-context window.
// 1M context is supported on Opus 4.7, Opus 4.6, and Sonnet 4.6 only —
// Haiku stays at 200k so there is no `claude-haiku-4-5[1m]` variant.
//
// Verified 2026-05-01 via Grok web research (4 rounds, sources cited in
// devlog/_plan/260501_claude_model_passthrough/02_grok_research_response.md).
export const CLAUDE_PINNED_FULL_IDS = [
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6[1m]',
  'claude-haiku-4-5',
] as const;

// Empty by design — user-typed Claude model strings pass through to
// `claude --model <literal>` unchanged. Claude Code resolves short aliases
// (opus, sonnet, sonnet[1m], haiku) internally via firstPartyNameToCanonical;
// pinned full IDs (claude-opus-4-7, claude-opus-4-7-20260416, etc.) reach the
// Anthropic Messages API verbatim so the literal the user pinned is what gets
// hashed for the prompt-cache prefix.
//
// Add a row here ONLY when a literal is fully retired by Anthropic and must
// be silently upgraded to a still-valid name.
export const CLAUDE_LEGACY_VALUE_MAP: Record<string, ClaudeCanonicalModel> = {};

export function isClaudeCli(cli: string): boolean {
  return cli === 'claude';
}

export function isClaudeCanonicalModel(model: string): model is ClaudeCanonicalModel {
  return (CLAUDE_CANONICAL_MODELS as readonly string[]).includes(model);
}

export function isKnownClaudeLegacyValue(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(CLAUDE_LEGACY_VALUE_MAP, model);
}

export function migrateLegacyClaudeValue(model: string): string {
  const value = (model || '').trim();
  if (!value) return value;
  return CLAUDE_LEGACY_VALUE_MAP[value] || value;
}

export function getDefaultClaudeModel(): ClaudeCanonicalModel {
  return 'sonnet';
}

export function getDefaultClaudeChoices(): string[] {
  // Aliases first (Claude Code resolves them to the current snapshot via
  // firstPartyNameToCanonical), then pinned full IDs for users who want
  // a stable cache prefix across CLI updates.
  return [...CLAUDE_CANONICAL_MODELS, ...CLAUDE_PINNED_FULL_IDS];
}

export function getClaudeModelKind(model: string): 'canonical' | 'legacy' | 'explicit' {
  const value = (model || '').trim();
  if (!value) return 'explicit';
  if (isClaudeCanonicalModel(value)) return 'canonical';
  if (isKnownClaudeLegacyValue(value)) return 'legacy';
  return 'explicit';
}
