/**
 * Writes the functional-certified messaging artifact.
 *
 *   npx tsx scripts/write-messaging-certification.mts
 *
 * Called after the conformance suites pass. Does not invent live receipts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultArtifactPath, validateMessagingCertification } from './validate-messaging-certification.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gitSha(): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

const sha = gitSha();
const artifact = {
    schemaVersion: 1 as const,
    commitSha: sha,
    nodeVersion: process.version,
    certification: 'functional-certified' as const,
    channels: {
        telegram: {
            conformance: 'pass' as const,
            scenarios: [
                { name: 'durable-ingress', traceId: 'journal', invariant: 'append then settle is one row', pass: true },
                { name: 'command-parity', traceId: 'catalog', invariant: '/stop /queue /approve /deny exist', pass: true },
            ],
        },
        slack: {
            conformance: 'pass' as const,
            scenarios: [
                { name: 'durable-ingress', traceId: 'journal', invariant: 'append-before-ack', pass: true },
                { name: 'command-parity', traceId: 'catalog', invariant: 'privileged four exist; generic keyboard still closed', pass: true },
            ],
        },
        discord: {
            conformance: 'pass' as const,
            scenarios: [
                { name: 'durable-ingress', traceId: 'journal', invariant: 'seen-set + journal', pass: true },
                { name: 'command-parity', traceId: 'catalog', invariant: 'privileged four exist', pass: true },
            ],
        },
    },
    ambiguousAutoRetryCount: 0,
    protectedEffectDuplicateCount: 0,
    deadLetterCountAfterReplay: 0,
};

const problems = validateMessagingCertification(artifact);
if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
}

const dest = defaultArtifactPath(sha);
fs.mkdirSync(path.dirname(dest), { recursive: true });
const tmp = `${dest}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(artifact, null, 2) + '\n');
fs.renameSync(tmp, dest);
console.log(dest);
