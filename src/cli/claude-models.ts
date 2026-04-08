// ─── Claude Model Normalization (single source of truth) ──────────

export const CLAUDE_CANONICAL_MODELS = [
  'sonnet',
  'opus',
  'sonnet[1m]',
  'opus[1m]',
  'haiku',
] as const;

export type ClaudeCanonicalModel = (typeof CLAUDE_CANONICAL_MODELS)[number];

export const CLAUDE_LEGACY_VALUE_MAP: Record<string, ClaudeCanonicalModel> = {
  'claude-sonnet-4-6': 'sonnet',
  'claude-opus-4-6': 'opus',
  'claude-sonnet-4-6[1m]': 'sonnet[1m]',
  'claude-opus-4-6[1m]': 'opus[1m]',
};

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
  return [...CLAUDE_CANONICAL_MODELS];
}

export function getClaudeModelKind(model: string): 'canonical' | 'legacy' | 'explicit' {
  const value = (model || '').trim();
  if (!value) return 'explicit';
  if (isClaudeCanonicalModel(value)) return 'canonical';
  if (isKnownClaudeLegacyValue(value)) return 'legacy';
  return 'explicit';
}
