import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JAW_HOME } from '../../core/config.js';

const LOG_NAME = 'churn-log.jsonl';
const DEFAULT_COMPACT_LIMIT = 500;

export interface ChurnRecord {
    key: string;
    vendor: string;
    feature: string;
    domHash: string;
    previousHash: string | null;
    state: string;
    capturedAt: string;
    healing?: unknown;
}

export interface FeatureReport {
    vendor: string;
    capturedAt?: string;
    features?: Array<{ feature: string; domHash?: string | null; state?: string; healing?: unknown }>;
}

export function churnLogPath(homeDir = JAW_HOME): string {
    return join(homeDir, LOG_NAME);
}

export function readChurnLog(homeDir = JAW_HOME): ChurnRecord[] {
    const path = churnLogPath(homeDir);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return [];
    const records: ChurnRecord[] = [];
    for (const line of raw.split('\n')) {
        if (!line) continue;
        try { records.push(JSON.parse(line) as ChurnRecord); } catch { /* skip malformed line */ }
    }
    return records;
}

export function appendChurnRecord(record: ChurnRecord, homeDir = JAW_HOME): void {
    const path = churnLogPath(homeDir);
    mkdirSync(homeDir, { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export function compactChurnLog(homeDir = JAW_HOME, limit = DEFAULT_COMPACT_LIMIT): number {
    const records = readChurnLog(homeDir);
    if (records.length <= limit) return records.length;
    const kept = records.slice(-limit);
    const path = churnLogPath(homeDir);
    writeFileSync(path, kept.map(r => JSON.stringify(r)).join('\n') + '\n');
    return kept.length;
}

export function maybeRecordChurn(report: FeatureReport, homeDir = JAW_HOME): ChurnRecord[] {
    if (process.env.AGBROWSE_CHURN_LOG !== '1') return [];
    const prior = readChurnLog(homeDir);
    const records = changedFeatureRecords(report, prior);
    for (const record of records) appendChurnRecord(record, homeDir);
    if (records.length > 0) compactChurnLog(homeDir);
    return records;
}

function changedFeatureRecords(report: FeatureReport, priorRecords: ChurnRecord[]): ChurnRecord[] {
    if (!report?.features?.length) return [];
    const changed: ChurnRecord[] = [];
    for (const f of report.features) {
        if (!f.domHash) continue;
        const key = `${report.vendor}:${f.feature}`;
        const last = findLastByKey(priorRecords, key);
        if (last && last.domHash === f.domHash) continue;
        changed.push({
            key,
            vendor: report.vendor,
            feature: f.feature,
            domHash: f.domHash,
            previousHash: last?.domHash || null,
            state: f.state || 'unknown',
            capturedAt: report.capturedAt || new Date().toISOString(),
            ...(f.healing ? { healing: f.healing } : {}),
        });
    }
    return changed;
}

function findLastByKey(records: ChurnRecord[], key: string): ChurnRecord | null {
    for (let i = records.length - 1; i >= 0; i -= 1) {
        const record = records[i];
        if (record && record.key === key) return record;
    }
    return null;
}
