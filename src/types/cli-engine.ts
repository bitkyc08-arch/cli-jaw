// @file src/types/cli-engine.ts
// Canonical discriminator for cli-jaw's supported CLI engines.
//
// Single source of truth. Every other module that names the engine union
// (currently: src/core/employees.ts EmployeeCli; future: P10 / P11 / P12)
// MUST import from this file rather than redeclaring the literal union.
//
// Member ordering is alphabetical for stable diffs. Runtime ordering for
// e.g. CLI_KEYS in src/cli/registry.ts is defined separately in that file
// — these are different concerns.
//
// Adding a new engine:
//   1. Add the literal here.
//   2. Add the runtime entry in src/cli/registry.ts (the registry will
//      no longer typecheck without it once P00.5 lands).
//   3. Update fixtures and per-engine event extractors (P11+).

export type CliEngine =
    | 'claude'
    | 'codex'
    | 'copilot'
    | 'gemini'
    | 'opencode';

/**
 * Runtime list of all engines, derived from the type via a `satisfies`
 * check so adding/removing a literal in `CliEngine` forces a corresponding
 * change here. Order is alphabetical to match the type declaration; do
 * NOT use this as the user-facing default ordering (that lives in
 * src/cli/readiness.ts DEFAULT_ORDER).
 */
export const CLI_ENGINES = [
    'claude',
    'codex',
    'copilot',
    'gemini',
    'opencode',
] as const satisfies readonly CliEngine[];

export function isCliEngine(value: unknown): value is CliEngine {
    return typeof value === 'string' && (CLI_ENGINES as readonly string[]).includes(value);
}
