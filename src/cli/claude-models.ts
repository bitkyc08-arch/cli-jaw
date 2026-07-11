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
// 1M context is supported on Fable 5, Sonnet 5, Opus 4.8, Opus 4.7, Opus 4.6,
// and Sonnet 4.6 — Haiku stays at 200k so there is no `claude-haiku-4-5[1m]`
// variant.
//
// Verified 2026-05-01 via Grok web research (4 rounds, sources cited in
// devlog/_plan/260501_claude_model_passthrough/02_grok_research_response.md).
export const CLAUDE_PINNED_FULL_IDS = [
  'claude-fable-5',
  'claude-fable-5[1m]',
  'claude-sonnet-5',
  'claude-sonnet-5[1m]',
  'claude-opus-4-8',
  'claude-opus-4-8[1m]',
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6[1m]',
  'claude-haiku-4-5',
] as const;

// Dot-form model strings that older UI versions persisted into settings.
// These are invalid for the Anthropic API (which uses hyphens), so we
// silently upgrade them to the correct hyphen-form. Full-ID → alias
// rewrites are intentionally absent: passthrough policy preserves the
// user's pinned literal for prompt-cache stability.
export const CLAUDE_LEGACY_VALUE_MAP: Record<string, string> = {
  'claude-opus-4.8': 'claude-opus-4-8',
  'claude-opus-4.7': 'claude-opus-4-7',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-sonnet-4.5': 'claude-sonnet-4-5',
  'claude-haiku-4.5': 'claude-haiku-4-5',
};

export function isClaudeCli(cli: string): boolean {
  return cli === 'claude' || cli === 'claude-e';
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

export function getDefaultClaudeModel(): string {
  return 'claude-opus-4-8';
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
