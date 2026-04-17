// ─── Employee Management ─────────────────────────────
// Shared employee seeding logic for web, telegram, discord contexts.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { getEmployees, deleteEmployee, insertEmployee } from './db.js';
import { settings } from './config.js';
import { broadcast } from './bus.js';
import { getDefaultClaudeModel } from '../cli/claude-models.js';
import { regenerateB } from '../prompt/builder.js';

export const DEFAULT_EMPLOYEES = [
    { name: 'Frontend', role: 'UI/UX, CSS, components' },
    { name: 'Backend', role: 'API, DB, server logic' },
    { name: 'Research', role: 'Search, codebase exploration, uncertainty reduction, read-only reports' },
    { name: 'Docs', role: 'Documentation, README, API docs' },
];

// ─── Static (code-defined) employees ─────────────────────────────
// Defined in code, not stored in the DB. Avoids a schema migration for
// employees that have fixed CLIs, runtime preconditions, or baked system
// prompts (e.g. Control needs Codex + Jaw.app + TCC). See
// devlog/_plan/computeruse/37_revisions_and_integration.md §C.

export type EmployeeCli = 'codex' | 'gemini' | 'claude' | 'opencode' | 'copilot';

export interface StaticEmployeeRuntimeHints {
    requiresDarwin?: boolean;
    requiresJawApp?: boolean;
    requiresCUApp?: boolean;
    requiresPathPin?: boolean;
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
            requiresJawApp: true,
            requiresCUApp: true,
            requiresPathPin: true,
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
 * Pure (besides platform + filesystem probes). Caller decides how to react:
 * dispatch returns 4xx on fail, warn on missing-but-optional Jaw.app.
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
    if (hints.requiresCUApp && platform === 'darwin'
        && !fs.existsSync('/Applications/Codex Computer Use.app')) {
        out.fail.push(
            `${spec.name} requires /Applications/Codex Computer Use.app — run: jaw doctor --tcc --fix`,
        );
    }
    if (hints.requiresJawApp && platform === 'darwin'
        && !fs.existsSync('/Applications/Jaw.app')) {
        out.warn.push(
            `${spec.name}: /Applications/Jaw.app missing — TCC attribution will fall back to node`,
        );
    }
    return out;
}

/**
 * Resolve an employee name to a dispatchable row-shape used by worker-registry
 * and runSingleAgent. DB rows win; static entries produce a synthetic id.
 */
export function resolveDispatchableEmployee(
    name: string,
    dbRows: Array<Record<string, any>> = getEmployees.all() as any[],
): { row: Record<string, any>; source: 'db' | 'static'; spec: StaticEmployee | null } | null {
    const needle = name.trim().toLowerCase();
    for (const r of dbRows) {
        if ((r.name || '').toLowerCase() === needle) {
            return { row: r, source: 'db', spec: findStaticEmployee(r.name) };
        }
    }
    const spec = findStaticEmployee(name);
    if (!spec) return null;
    return {
        row: {
            id: `static:${spec.name.toLowerCase()}`,
            name: spec.name,
            cli: spec.cli,
            model: spec.model ?? 'default',
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
    type Row = { name: string; cli: string; model: string | null; role: string | null };
    const dbRows = getEmployees.all() as Row[];
    const seen = new Set<string>();
    const out: EmployeeListing[] = [];
    for (const r of dbRows) {
        if (!r?.name) continue;
        out.push({
            name: r.name,
            cli: r.cli,
            model: r.model,
            role: r.role ?? '',
            source: 'db',
        });
        seen.add(r.name.toLowerCase());
    }
    for (const s of STATIC_EMPLOYEES) {
        if (seen.has(s.name.toLowerCase())) continue;
        out.push({
            name: s.name,
            cli: s.cli,
            model: s.model,
            role: s.description,
            source: 'static',
            runtimeHints: s.runtimeHints,
            skills: s.skills,
            systemPromptPatchFile: s.systemPromptPatchFile,
            delegation: s.delegation,
            defer: s.defer,
        });
    }
    return out;
}

export function seedDefaultEmployees({ reset = false, notify = false } = {}) {
    const existing = getEmployees.all();
    if (reset) {
        for (const emp of existing) deleteEmployee.run((emp as any).id);
    } else if (existing.length > 0) {
        return { seeded: 0, cli: settings.cli, skipped: true };
    }

    const cli = settings.cli;
    const defaultModel = cli === 'claude' ? getDefaultClaudeModel() : 'default';
    for (const emp of DEFAULT_EMPLOYEES) {
        insertEmployee.run(crypto.randomUUID(), emp.name, cli, defaultModel, emp.role);
    }
    if (notify) broadcast('agent_updated', {});
    regenerateB();
    return { seeded: DEFAULT_EMPLOYEES.length, cli, skipped: false };
}
