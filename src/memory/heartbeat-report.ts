export type HeartbeatReportStatus = 'ok' | 'warning' | 'failed';

export interface HeartbeatReport {
    status: HeartbeatReportStatus;
    changed: boolean;
    recordRequired: boolean;
    userVisible: boolean;
    summary: string;
    evidence: string;
    nextAction: string;
    raw: string;
}

const SCAN_LIMIT = 8 * 1024;
const KEYS = new Set(['status', 'changed', 'record_required', 'user_visible', 'summary', 'evidence', 'next_action']);

function booleanValue(value: string): boolean {
    return /^(?:yes|true|1)$/i.test(value.trim());
}

export function parseHeartbeatReport(raw: string, scriptExitCode?: number | null): HeartbeatReport {
    const scanned = raw.slice(0, SCAN_LIMIT);
    const values = new Map<string, string>();
    const lines = scanned.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];
        if (line === undefined) continue;
        const match = /^([a-z_]+):\s*(.*)$/i.exec(line.trim());
        if (!match || !match[1] || !KEYS.has(match[1].toLowerCase())) {
            if (values.size > 0 && line.trim()) break;
            continue;
        }
        values.set(match[1].toLowerCase(), match[2] || '');
    }
    const explicitStatus = values.get('status')?.toLowerCase();
    const status: HeartbeatReportStatus = explicitStatus === 'warning' || explicitStatus === 'failed' || explicitStatus === 'ok'
        ? explicitStatus
        : scriptExitCode != null && scriptExitCode !== 0 ? 'failed' : 'ok';
    return {
        status,
        changed: booleanValue(values.get('changed') || ''),
        recordRequired: booleanValue(values.get('record_required') || ''),
        userVisible: booleanValue(values.get('user_visible') || ''),
        summary: values.size > 0 ? (values.get('summary') || scanned.trim()) : scanned.trim(),
        evidence: values.get('evidence') || '',
        nextAction: values.get('next_action') || '',
        raw,
    };
}
