/**
 * Validates a messaging certification artifact.
 *
 *   npx tsx scripts/validate-messaging-certification.mts [path]
 *
 * Default path: .artifacts/messaging-certification/<HEAD>/summary.json
 * This cycle certifies the suites that exist. The file must say
 * functional-certified. release-certified is a hard fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANNELS = ['telegram', 'slack', 'discord'] as const;

function gitSha(): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export function defaultArtifactPath(sha = gitSha()): string {
    return path.join(repoRoot, '.artifacts', 'messaging-certification', sha, 'summary.json');
}

export function validateMessagingCertification(raw: unknown): string[] {
    const problems: string[] = [];
    if (!raw || typeof raw !== 'object') return ['artifact is not an object'];
    const row = raw as Record<string, unknown>;
    if (row['schemaVersion'] !== 1) problems.push('schemaVersion must be 1');
    if (typeof row['commitSha'] !== 'string' || !/^[0-9a-f]{40}$/.test(row['commitSha'])) {
        problems.push('commitSha must be a 40-char hex sha');
    }
    if (typeof row['nodeVersion'] !== 'string' || row['nodeVersion'].length === 0) {
        problems.push('nodeVersion missing');
    }
    if (row['certification'] !== 'functional-certified') {
        problems.push('certification must be functional-certified (release-certified is forbidden without live canary)');
    }
    if (row['liveCanary'] !== undefined) problems.push('liveCanary must be absent until an attended canary exists');
    for (const key of ['ambiguousAutoRetryCount', 'protectedEffectDuplicateCount', 'deadLetterCountAfterReplay']) {
        if (row[key] !== 0) problems.push(`${key} must be 0`);
    }
    const channels = row['channels'];
    if (!channels || typeof channels !== 'object') {
        problems.push('channels missing');
        return problems;
    }
    const channelRow = channels as Record<string, unknown>;
    for (const name of CHANNELS) {
        const ch = channelRow[name];
        if (!ch || typeof ch !== 'object') {
            problems.push(`channels.${name} missing`);
            continue;
        }
        const rec = ch as Record<string, unknown>;
        if (rec['conformance'] !== 'pass') problems.push(`channels.${name}.conformance is not pass`);
        if (!Array.isArray(rec['scenarios']) || rec['scenarios'].length === 0) {
            problems.push(`channels.${name}.scenarios empty`);
        } else if (rec['scenarios'].some((s) => !s || typeof s !== 'object' || (s as { pass?: unknown }).pass !== true)) {
            problems.push(`channels.${name} has a failing scenario`);
        }
    }
    const extra = Object.keys(channelRow).filter((k) => !CHANNELS.includes(k as typeof CHANNELS[number]));
    if (extra.length > 0) problems.push(`unknown channels: ${extra.join(', ')}`);
    return problems;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
    const target = process.argv[2] || defaultArtifactPath();
    if (!fs.existsSync(target)) {
        console.error(`missing artifact: ${target}`);
        process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown;
    const problems = validateMessagingCertification(raw);
    if (problems.length > 0) {
        console.error(problems.join('\n'));
        process.exit(1);
    }
    console.log(`ok ${target}`);
}
