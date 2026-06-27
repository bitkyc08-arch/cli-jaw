// Parity catalog 102 (control-summary, demoted P3). Strict-TS port of agbrowse
// web-ai/control-summary.mjs. Emits a one-line browser-control state summary to
// stderr (cdp / tab / session / chrome) for observability. Never includes prompt
// text, file contents, or model info. `formatControlSummary` is pure/testable.

export interface ControlSummaryInput {
    cdpPort?: number;
    tabSource?: string;
    sessionReuse?: boolean;
    recoveryUrl?: string;
    chromeVisible?: boolean;
    remoteChrome?: boolean;
}

export interface ControlSummaryFlags {
    controlSummary?: boolean;
    json?: boolean;
}

/**
 * Format a browser control state summary for stderr. Never includes prompt text,
 * file contents, or model info.
 */
export function formatControlSummary(opts: ControlSummaryInput = {}): string {
    const {
        cdpPort = 9222,
        tabSource = 'new',
        sessionReuse = false,
        recoveryUrl,
        chromeVisible = true,
        remoteChrome = false,
    } = opts;
    const lines: string[] = [];

    const chromeMode = remoteChrome
        ? `remote CDP on port ${cdpPort}`
        : `attached to running Chrome on port ${cdpPort}`;
    lines.push(`[browser] cdp=localhost:${cdpPort} (${chromeMode})`);

    const tabDesc = tabSource === 'pooled'
        ? 'pooled (reusing warm session tab)'
        : tabSource === 'new-tab'
            ? 'new (fresh tab created)'
            : 'active (existing active tab)';
    lines.push(`[browser] tab=${tabDesc}`);

    if (sessionReuse && recoveryUrl) {
        lines.push(`[browser] session=recovered from ${recoveryUrl}`);
    } else {
        lines.push('[browser] session=new');
    }

    if (chromeVisible) {
        lines.push('[browser] chrome=visible (may focus window)');
    } else {
        lines.push('[browser] chrome=headless');
    }

    return lines.join('\n');
}

/** Print the control summary to stderr if conditions are met (not in --json mode). */
export function emitControlSummary(opts: ControlSummaryInput, flags: ControlSummaryFlags = {}): void {
    const { controlSummary = false, json = false } = flags;
    if (!controlSummary || json) return;
    process.stderr.write(formatControlSummary(opts) + '\n');
}
