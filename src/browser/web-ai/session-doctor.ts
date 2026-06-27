// Parity catalog 102 (session-doctor). Strict-TS port of agbrowse web-ai/session-doctor.mjs.
// Read-only session diagnostic report: never reads prompt/answer text and redacts
// conversation URLs to host + pathname. cli-jaw doctor.ts is a feature-capability prober —
// it does NOT cover session-level reporting (lock PID/staleness + verifySessionTab). Deps
// are injected (cli-jaw's session/lock/tab APIs are spread across modules) so the report
// builder is fully unit-testable; sanitize/summarize/recommend helpers are pure.

export interface DoctorSession {
    sessionId: string;
    vendor?: string;
    status?: string;
    deadlineAt?: number | string | null;
    targetId?: string | null;
    tabId?: string | null;
    originalUrl?: string | null;
    conversationUrl?: string | null;
    updatedAt?: string;
    warnings?: unknown[];
    lastError?: unknown;
    tabState?: unknown;
}

export interface DoctorLock {
    pid?: number;
    stale?: boolean;
}

export interface DoctorTarget {
    valid?: boolean;
    needsRecovery?: boolean;
    error?: string;
}

export interface SessionDoctorDeps {
    getSession(sessionId: string): DoctorSession | null | undefined;
    readSessionCommandLock(sessionId: string): DoctorLock | null;
    verifySessionTab(session: DoctorSession): Promise<DoctorTarget>;
    listActiveCommands(scope: { browserProfileKey: string }): Promise<unknown[]>;
    getPort?(): number;
}

export interface SessionDoctorReport {
    ok: boolean;
    status: 'session-doctor';
    sessionId: string;
    vendor?: string;
    summary: string;
    session?: ReturnType<typeof sanitizeSession>;
    target?: DoctorTarget;
    lock?: DoctorLock | null;
    activeCommands?: unknown[];
    recommendations: string[];
}

/**
 * Build a session diagnostic report. Read-only: never reads prompt or answer text,
 * and redacts conversation URLs down to host + pathname.
 */
export async function buildSessionDoctorReport(
    deps: SessionDoctorDeps,
    sessionId: string,
    options: { navigate?: boolean } = {},
): Promise<SessionDoctorReport> {
    const session = deps.getSession(sessionId);
    if (!session) {
        return {
            ok: false,
            status: 'session-doctor',
            sessionId,
            summary: 'missing session record',
            recommendations: ['Run: web-ai sessions list'],
        };
    }
    const port = (typeof deps.getPort === 'function' ? deps.getPort() : 9222) || 9222;
    const target = await deps.verifySessionTab(session).catch((error): DoctorTarget => ({
        valid: false,
        needsRecovery: true,
        error: (error as { message?: string })?.message || String(error),
    }));
    const lock = deps.readSessionCommandLock(sessionId);
    const activeCommands = await deps.listActiveCommands({ browserProfileKey: String(port) })
        .catch((error): unknown[] => [{ status: 'unknown', error: (error as { message?: string })?.message || String(error) }]);
    const recommendations = recommendSessionActions({ session, target, lock, navigate: options.navigate === true });
    const report: SessionDoctorReport = {
        ok: true,
        status: 'session-doctor',
        sessionId,
        summary: summarizeSession({ session, target, lock }),
        session: sanitizeSession(session),
        target,
        lock,
        activeCommands,
        recommendations,
    };
    if (session.vendor) report.vendor = session.vendor;
    return report;
}

/** Redact a session record to the safe, reportable fields (URLs → host+path). */
export function sanitizeSession(session: DoctorSession): {
    sessionId: string;
    vendor: string | undefined;
    status: string | undefined;
    deadlineAt: number | string | null;
    targetId: string | null;
    tabId: string | null;
    originalUrl: string | null;
    conversationUrl: string | null;
    updatedAt: string | undefined;
    warnings: unknown[];
    lastError: unknown;
    tabState: unknown;
} {
    return {
        sessionId: session.sessionId,
        vendor: session.vendor,
        status: session.status,
        deadlineAt: session.deadlineAt ?? null,
        targetId: session.targetId || null,
        tabId: session.tabId || null,
        originalUrl: redactUrl(session.originalUrl),
        conversationUrl: redactUrl(session.conversationUrl),
        updatedAt: session.updatedAt,
        warnings: session.warnings || [],
        lastError: session.lastError ?? null,
        tabState: session.tabState ?? null,
    };
}

export function summarizeSession({ session, target, lock }: { session: DoctorSession; target: DoctorTarget; lock: DoctorLock | null }): string {
    if (lock?.pid && lock?.stale === false) return 'locked by another command';
    if (!target?.valid) return 'target missing or needs recovery';
    return `${session.status} on live target`;
}

export function recommendSessionActions({
    session,
    target,
    lock,
    navigate,
}: { session: DoctorSession; target: DoctorTarget; lock: DoctorLock | null; navigate: boolean }): string[] {
    const out: string[] = [];
    if (lock?.pid && lock?.stale === false) {
        out.push('A command lock is active; wait or inspect the PID before retrying.');
    }
    if (!target?.valid && navigate) {
        out.push(`Run sessions reattach ${session.sessionId} --navigate to recover the tab.`);
    }
    if (!target?.valid && !navigate) {
        out.push(`Run sessions doctor ${session.sessionId} --navigate or poll --session ${session.sessionId} --navigate.`);
    }
    if (session.status === 'timeout') {
        out.push('If the provider tab is still streaming and deadline is future, retry poll/watch with --session.');
    }
    if (out.length === 0) {
        out.push(`Run: web-ai poll --vendor ${session.vendor || 'chatgpt'} --session ${session.sessionId} --navigate`);
    }
    return out;
}

function redactUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.hostname}${u.pathname}`;
    } catch {
        return String(url);
    }
}
