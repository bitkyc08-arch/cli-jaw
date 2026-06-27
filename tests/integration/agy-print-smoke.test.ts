import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractAgyConversationId } from '../../src/agent/agy-runtime.ts';
import {
    AGY_LAST_CONVERSATIONS,
    resolveAgyTranscriptPathForCurrentTurn,
} from '../../src/agent/agy-transcript.ts';

const SMOKE_TIMEOUT_MS = 180_000;

type FileSnapshot = {
    existed: boolean;
    bytes?: Buffer;
};

function snapshotFile(filePath: string): FileSnapshot {
    if (!fs.existsSync(filePath)) return { existed: false };
    return { existed: true, bytes: fs.readFileSync(filePath) };
}

function restoreFile(filePath: string, snapshot: FileSnapshot): void {
    if (snapshot.existed) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, snapshot.bytes ?? Buffer.alloc(0));
        return;
    }
    fs.rmSync(filePath, { force: true });
}

function redactDiagnostics(value: string): string {
    return value
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'redacted@example.invalid')
        .replace(new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<HOME>');
}

async function runAgy(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
        const child = spawn('agy', args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
        }, SMOKE_TIMEOUT_MS);
        timer.unref();
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => {
            clearTimeout(timer);
            reject(new Error(redactDiagnostics(`failed to start agy: ${error.message}`)));
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            reject(new Error(redactDiagnostics([
                `agy failed with code ${String(code ?? 'unknown')}`,
                signal ? `signal ${signal}` : '',
                signal ? `spawn timeout after ${SMOKE_TIMEOUT_MS}ms may have killed the process` : '',
                stdout ? `stdout: ${stdout}` : '',
                stderr ? `stderr: ${stderr}` : '',
            ].filter(Boolean).join('\n'))));
        });
    });
}

async function assertAgySmokeCapabilities(): Promise<void> {
    const { stdout, stderr } = await runAgy(['--help'], process.cwd());
    const help = `${stdout}\n${stderr}`;
    for (const flag of ['-p', '--conversation', '--log-file', '--print-timeout']) {
        assert.ok(help.includes(flag), `agy --help must expose ${flag}`);
    }
}

function conversationIdFrom(stdout: string, stderr: string, logFile: string): string | null {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    return extractAgyConversationId(`${stdout}\n${stderr}\n${log}`);
}

const enabled = process.env['JAW_AGY_SMOKE'] === '1';

test('AGY print smoke: fresh and exact resume', { skip: !enabled }, async () => {
    await assertAgySmokeCapabilities();

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-jaw-agy-smoke-'));
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-jaw-agy-log-'));
    const lastConversationsSnapshot = snapshotFile(AGY_LAST_CONVERSATIONS);
    try {
        fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'AGY smoke workspace instruction sentinel.\n');
        fs.writeFileSync(path.join(cwd, 'GEMINI.md'), 'AGY smoke Gemini instruction sentinel.\n');

        const freshPrompt = 'CLI_JAW_AGY_SMOKE_FRESH. Reply with exactly: AGY_SMOKE_OK. Do not inspect files. Do not run commands.';
        const freshLog = path.join(logDir, 'fresh.log');
        const startedAt = Date.now();
        const fresh = await runAgy(['-p', freshPrompt, '--log-file', freshLog, '--print-timeout', '1m'], cwd);
        assert.match(fresh.stdout, /AGY_SMOKE_OK/);

        const conversationId = conversationIdFrom(fresh.stdout, fresh.stderr, freshLog);
        assert.ok(conversationId, 'fresh AGY smoke must expose a conversation id in stdout/stderr/log');

        const transcript = resolveAgyTranscriptPathForCurrentTurn(cwd, conversationId, startedAt - 5_000, freshPrompt);
        if (transcript.ok && transcript.transcriptPath) {
            const transcriptText = fs.readFileSync(transcript.transcriptPath, 'utf8');
            assert.ok(transcriptText.includes('CLI_JAW_AGY_SMOKE_FRESH'), 'transcript must include fresh prompt sentinel');
        }

        const resumePrompt = 'CLI_JAW_AGY_SMOKE_RESUME. Reply with exactly: AGY_RESUME_OK. Do not inspect files. Do not run commands.';
        const resumeLog = path.join(logDir, 'resume.log');
        const resume = await runAgy([
            '--conversation', conversationId,
            '-p', resumePrompt,
            '--log-file', resumeLog,
            '--print-timeout', '1m',
        ], cwd);
        assert.match(resume.stdout, /AGY_RESUME_OK/);
        assert.doesNotMatch(resume.stderr, /--continue/);
    } finally {
        restoreFile(AGY_LAST_CONVERSATIONS, lastConversationsSnapshot);
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(logDir, { recursive: true, force: true });
    }
}, { timeout: SMOKE_TIMEOUT_MS * 2 });
