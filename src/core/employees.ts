// ─── Employee Management ─────────────────────────────
// Shared employee seeding logic for web, telegram, discord contexts.

import crypto from 'node:crypto';
import { getEmployees, deleteEmployee, insertEmployee, db } from './db.js';
import { settings } from './config.js';
import { stripUndefined } from './strip-undefined.js';
import { broadcast } from './bus.js';
import { getDefaultClaudeModel } from '../cli/claude-models.js';
import { regenerateB } from '../prompt/builder.js';
import type { CliEngine } from '../types/cli-engine.js';

export const DEFAULT_EMPLOYEES = [
    { name: 'Frontend', role: 'UI/UX, CSS, components' },
    { name: 'Backend', role: 'API, DB, server logic' },
    { name: 'Docs', role: 'Documentation, README, API docs' },
];

// ─── Static (code-defined) employees ─────────────────────────────
// Defined in code, not stored in the DB. Avoids a schema migration for
// employees that have fixed CLIs or baked system prompts (e.g. Control
// needs Codex + darwin).

/**
 * @deprecated Prefer `CliEngine` from `src/types/cli-engine.ts`. This alias
 * is retained to avoid a renaming churn across employees.ts call sites; it
 * will be removed in P19/P20 cleanup once consumers have migrated.
 */
export type EmployeeCli = CliEngine;

export interface StaticEmployeeRuntimeHints {
    requiresDarwin?: boolean;
}

export interface StaticEmployee {
    name: string;
    cli: EmployeeCli;
    model?: string;
    description: string;
    skills: string[];
    /** Path relative to src/prompt/templates/; loaded at dispatch time. */
    systemPromptPatchFile?: string;
    runtimeHints?: StaticEmployeeRuntimeHints;
    delegation?: {
        mode: 'preferred_for_long_sessions' | 'exclusive';
        boss_may_self_serve?: boolean;
    };
    defer?: {
        when: 'not-gui-automation';
        back_to: 'Boss';
    };
}

/**
 * Shape of a row returned by `getEmployees.all()` (see ./db.ts).
 * Derived from the schema in db.ts; keep in sync if the schema changes.
 */
export interface EmployeeRow {
    id: string;
    name: string;
    cli: string;          // not narrowed to CliEngine yet — DB may carry legacy values
    model: string | null;
    role: string | null;
    [k: string]: unknown; // allow forward-compatible columns
}

/**
 * Synthetic row produced when a request resolves to a STATIC_EMPLOYEES entry
 * (no real DB id). Shape mirrors the columns the dispatch path actually reads.
 */
export interface SyntheticEmployeeRow {
    id: string;
    name: string;
    cli: string;
    model: string;
    role: string;
    status: 'idle';
}

export const STATIC_EMPLOYEES: StaticEmployee[] = [
    {
        name: 'Control',
        cli: 'codex',
        description: 'Desktop + browser automation specialist (NOT exclusive — Boss-as-codex may self-serve).',
        // vision-click is absorbed into desktop-control (reference/vision-click.md).
        // Keep skills minimal; screen-capture stays for non-Chrome OS capture.
        skills: ['desktop-control', 'screen-capture'],
        systemPromptPatchFile: 'control-system.md',
        runtimeHints: {
            requiresDarwin: true,
        },
        delegation: {
            mode: 'preferred_for_long_sessions',
            boss_may_self_serve: true,
        },
        defer: { when: 'not-gui-automation', back_to: 'Boss' },
    },
];

export function findStaticEmployee(name: string): StaticEmployee | null {
    const needle = name.trim().toLowerCase();
    return STATIC_EMPLOYEES.find((e) => e.name.toLowerCase() === needle) ?? null;
}

export interface EmployeeListing {
    /** DB employees have no synthetic id here (use row id separately);
     *  static employees use `static:<name-lower>` so the frontend can PUT to
     *  the overrides endpoint. */
    id?: string;
    name: string;
    cli: string;
    model?: string | null;
    role: string;
    source: 'db' | 'static';
    runtimeHints?: StaticEmployeeRuntimeHints;
    skills?: string[];
    systemPromptPatchFile?: string;
    delegation?: StaticEmployee['delegation'];
    defer?: StaticEmployee['defer'];
}

export interface RuntimeHintCheckResult {
    fail: string[];
    warn: string[];
}

/**
 * Evaluate runtime preconditions for a static employee on the current host.
 * Pure (platform probe only). Caller decides how to react: dispatch returns
 * 4xx on fail.
 */
export function checkRuntimeHints(
    spec: StaticEmployee,
    platform: NodeJS.Platform = process.platform,
): RuntimeHintCheckResult {
    const out: RuntimeHintCheckResult = { fail: [], warn: [] };
    const hints = spec.runtimeHints;
    if (!hints) return out;
    if (hints.requiresDarwin && platform !== 'darwin') {
        out.fail.push(`${spec.name} requires macOS (current: ${platform})`);
    }
    return out;
}

/**
 * Evaluate model/CLI precondition at dispatch time — same shape as checkRuntimeHints
 * so the caller (orchestrate.ts) can translate fail/warn into HTTP 412/warning.
 * Pure function: no network, no probes. Encode KNOWN model-level incompatibilities
 * we cannot recover from after spawn.
 *
 * Spark note: `gpt-5.3-codex-spark` does NOT accept the `reasoning.summary` /
 * `reasoning.effort` parameters (server returns 400 "unsupported_parameter").
 * `args.ts` already drops those flags via `isCodexSparkModel`, so no fail is
 * needed here — the guard is exercised at argv-build time, not dispatch time.
 * This scaffold is kept for future model-policy additions.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function checkModelSupport(
    _cli: string | undefined | null,
    _model: string | undefined | null,
    _env: NodeJS.ProcessEnv = process.env,
): RuntimeHintCheckResult {
    return { fail: [], warn: [] };
}

/**
 * Resolve an employee name to a dispatchable row-shape used by worker-registry
 * and runSingleAgent. DB rows win; static entries produce a synthetic id.
 */
export function resolveDispatchableEmployee(
    name: string,
    dbRows: readonly EmployeeRow[] = getEmployees.all() as EmployeeRow[],
): { row: EmployeeRow | SyntheticEmployeeRow; source: 'db' | 'static'; spec: StaticEmployee | null } | null {
    const needle = name.trim().toLowerCase();
    for (const r of dbRows) {
        if ((r.name ?? '').toLowerCase() === needle) {
            return { row: r, source: 'db', spec: findStaticEmployee(r.name) };
        }
    }
    const spec = findStaticEmployee(name);
    if (!spec) return null;
    const override = (settings["staticEmployees"] as Record<string, { model?: string }> | undefined)?.[spec.name];
    return {
        row: {
            id: `static:${spec.name.toLowerCase()}`,
            name: spec.name,
            cli: spec.cli,
            model: override?.model ?? spec.model ?? 'default',
            role: spec.description,
            status: 'idle',
        },
        source: 'static',
        spec,
    };
}

/**
 * Return DB employees merged with STATIC_EMPLOYEES by case-insensitive name.
 * DB rows take precedence when names collide; static entries only fill gaps.
 */
export function listEmployees(): EmployeeListing[] {
    type Row = { id: string; name: string; cli: string; model: string | null; role: string | null };
    const dbRows = getEmployees.all() as Row[];
    const seen = new Set<string>();
    const staticOut: EmployeeListing[] = [];
    const dbOut: EmployeeListing[] = [];
    const overrides = (settings["staticEmployees"] as Record<string, { model?: string }> | undefined) || {};

    // Static employees first (rendered at top of UI list, CLI-locked, model editable).
    for (const s of STATIC_EMPLOYEES) {
        const override = overrides[s.name];
        staticOut.push(stripUndefined({
            // Use synthetic id matching resolveDispatchableEmployee so the frontend
            // can round-trip PUT /api/employees/:id to the override storage.
            id: `static:${s.name.toLowerCase()}`,
            name: s.name,
            cli: s.cli,
            model: override?.model ?? s.model ?? 'default',
            role: s.description,
            source: 'static',
            runtimeHints: s.runtimeHints,
            skills: s.skills,
            systemPromptPatchFile: s.systemPromptPatchFile,
            delegation: s.delegation,
            defer: s.defer,
        }));
        seen.add(s.name.toLowerCase());
    }

    for (const r of dbRows) {
        if (!r?.name) continue;
        // DB entries with the same name as a static one take precedence for dispatch,
        // but we keep the static slot visible in UI. Skip the DB dup in listing.
        if (seen.has(r.name.toLowerCase())) continue;
        dbOut.push({
            id: r.id,
            name: r.name,
            cli: r.cli,
            model: r.model,
            role: r.role ?? '',
            source: 'db',
        });
    }

    return [...staticOut, ...dbOut];
}

export function seedDefaultEmployees({ reset = false, notify = false } = {}) {
    if (!db.open) return { seeded: 0, cli: settings["cli"], skipped: true };
    const existing = getEmployees.all() as EmployeeRow[];
    if (reset) {
        for (const emp of existing) deleteEmployee.run(emp.id);
    } else if (existing.length > 0) {
        return { seeded: 0, cli: settings["cli"], skipped: true };
    }

    const cli = settings["cli"];
    const defaultModel = cli === 'claude' ? getDefaultClaudeModel() : 'default';
    for (const emp of DEFAULT_EMPLOYEES) {
        insertEmployee.run(crypto.randomUUID(), emp.name, cli, defaultModel, emp.role);
    }
    if (notify) broadcast('agent_updated', {});
    regenerateB();
    return { seeded: DEFAULT_EMPLOYEES.length, cli, skipped: false };
}
