// Native Code capacity defaults. Public session contracts live in wire.ts.

export interface CodeSettings {
    maxConcurrentSessions: number;
    idleReapMs: number;
}

/** Single source of truth for code-mode defaults (also seeded in core/config.ts). */
export const DEFAULT_CODE_SETTINGS: CodeSettings = {
    maxConcurrentSessions: 4,
    idleReapMs: 30_000,
};
