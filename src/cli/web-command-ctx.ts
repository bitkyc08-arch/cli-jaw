// ─── Web command context factory ──────────────────────
// Extracted from server.ts in Phase 2.
// Builds the CommandCtx for web-origin slash commands (/api/command,
// /api/message, skill routes).

import type { Request } from 'express';
import { makeCommandCtx } from './command-context.js';
import { resolveRequestLocale } from '../http/locale.js';
import { applySettingsPatch, clearSessionState, resetSessionOnly } from '../core/session-ops.js';
import { resetEmployeeSessions, seedDefaultEmployees } from '../core/employees.js';

export function makeWebCommandCtx(req: Request, localeOverride: string | null = null) {
    return makeCommandCtx('web', resolveRequestLocale(req, localeOverride), {
        applySettings: (patch) => applySettingsPatch(patch),
        clearSession: () => clearSessionState(),
        resetSession: () => resetSessionOnly(),
        resetEmployees: () => seedDefaultEmployees({ reset: true, notify: true }),
        resetEmployeeSessions: () => resetEmployeeSessions(),
    });
}
