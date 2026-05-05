import fs from 'fs';
import os from 'os';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { buildArgs } from '../../src/agent/args.js';
import { extractFromEvent, extractOutputChunk } from '../../src/agent/events.js';
import type { SpawnContext } from '../../src/types/agent.js';
import type { CliEventRecord } from '../../src/types/cli-events.js';
import {
    applyCliEnvDefaults,
    ensureOpencodeAlwaysAllowPermissions,
} from '../../src/agent/spawn-env.js';
import {
    readOpencodeVersion,
    resolveOpencodeBinary,
} from '../../src/agent/opencode-diagnostics.js';

type SmokeCase = {
    id: string;
    targetKind: 'temp-external' | 'jaw-like-external';
    fileRel: string;
    action: 'create' | 'modify' | 'summarize';
    fileKind: 'text' | 'markdown' | 'json';
    prompt: (targetFile: string, marker: string, extraFiles: string[]) => string;
    seed?: (targetFile: string, marker: string, extraFiles: string[]) => void;
};

type RunResult = {
    id: string;
    pass: boolean;
    classification: 'PASS' | 'PERMISSION_FAILURE' | 'PARSER_FAILURE' | 'RUNTIME_STALL' | 'TOOL_EXECUTION_FAILURE';
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
    cwd: string;
    externalDir: string;
    targetFile: string;
    marker: string;
    stdoutFile: string;
    stderrFile: string;
    resultFile: string;
    eventCount: number;
    eventTypes: Record<string, number>;
    parseErrors: string[];
    stderrPermissionHit: boolean;
    stdoutPermissionHit: boolean;
    hasErrorEvent: boolean;
    hasStepFinish: boolean;
    hasTextEvent: boolean;
    parserFullTextLength: number;
    parserLiveTextLength: number;
    fileExists: boolean;
    markerFound: boolean;
    notes: string[];
};

const MODEL = 'opencode-go/deepseek-v4-pro';
const RUNS = Number.parseInt(readArg('--runs') || '12', 10);
const TIMEOUT_MS = Number.parseInt(readArg('--timeout-ms') || '180000', 10);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const baseFixtureDir = join(process.cwd(), 'devlog', '_plan', 'parse', 'fixtures', 'opencode-smoke-260426', stamp);
const tempRoot = join(os.tmpdir(), `jaw-opencode-smoke-${stamp}`);

const cases: SmokeCase[] = [
    createCase('run-01', 'temp-external', 'note.txt', 'create', 'text'),
    createCase('run-02', 'temp-external', 'note.txt', 'modify', 'text'),
    createCase('run-03', 'temp-external', 'doc.md', 'create', 'markdown'),
    createCase('run-04', 'temp-external', 'doc.md', 'modify', 'markdown'),
    createCase('run-05', 'temp-external', 'data.json', 'create', 'json'),
    createCase('run-06', 'temp-external', 'data.json', 'modify', 'json'),
    createCase('run-07', 'temp-external', 'nested/report.md', 'create', 'markdown'),
    createCase('run-08', 'temp-external', 'nested/report.md', 'modify', 'markdown'),
    createCase('run-09', 'jaw-like-external', 'jaw-note.txt', 'create', 'text'),
    createCase('run-10', 'jaw-like-external', 'jaw-note.txt', 'modify', 'text'),
    summarizeCase('run-11', 'temp-external', 'summary.md'),
    createCase('run-12', 'temp-external', 'final.md', 'modify', 'markdown'),
];

function readArg(name: string): string | null {
    const idx = process.argv.indexOf(name);
    if (idx === -1) return null;
    return process.argv[idx + 1] || null;
}

function createCase(
    id: string,
    targetKind: SmokeCase['targetKind'],
    fileRel: string,
    action: SmokeCase['action'],
    fileKind: SmokeCase['fileKind'],
): SmokeCase {
    return {
        id,
        targetKind,
        fileRel,
        action,
        fileKind,
        seed: action === 'modify'
            ? (targetFile, marker) => {
                fs.mkdirSync(dirname(targetFile), { recursive: true });
                fs.writeFileSync(targetFile, `seed for ${id}\nold-marker=${marker}-old\n`, 'utf8');
            }
            : undefined,
        prompt: (targetFile, marker) => buildPrompt(id, action, fileKind, targetFile, marker),
    };
}

function summarizeCase(
    id: string,
    targetKind: SmokeCase['targetKind'],
    fileRel: string,
): SmokeCase {
    return {
        id,
        targetKind,
        fileRel,
        action: 'summarize',
        fileKind: 'markdown',
        seed: (_targetFile, marker, extraFiles) => {
            for (const [idx, file] of extraFiles.entries()) {
                fs.mkdirSync(dirname(file), { recursive: true });
                fs.writeFileSync(file, `source-${idx + 1}\nmarker=${marker}\n`, 'utf8');
            }
        },
        prompt: (targetFile, marker, extraFiles) => [
            `You are running an unattended smoke test ${id}.`,
            `Working directory is intentionally different from the target directory.`,
            `Read these external files: ${extraFiles.join(', ')}`,
            `Create the external markdown file at this absolute path: ${targetFile}`,
            `The file must contain this exact marker: ${marker}`,
            `Do not ask for permission. Use tools directly.`,
            `When finished, answer exactly: DONE ${id} ${marker}`,
        ].join('\n'),
    };
}

function buildPrompt(
    id: string,
    action: SmokeCase['action'],
    fileKind: SmokeCase['fileKind'],
    targetFile: string,
    marker: string,
): string {
    const verb = action === 'modify' ? 'Modify the existing' : 'Create a new';
    const content = fileKind === 'json'
        ? `valid JSON with keys "run", "marker", and "status"; marker must be "${marker}"`
        : `${fileKind} content containing the exact marker "${marker}"`;
    return [
        `You are running an unattended smoke test ${id}.`,
        `Working directory is intentionally different from the target directory.`,
        `${verb} external ${fileKind} file at this absolute path: ${targetFile}`,
        `The file must contain ${content}.`,
        `Do not ask for permission. Use tools directly.`,
        `When finished, answer exactly: DONE ${id} ${marker}`,
    ].join('\n');
}

function permissionHit(text: string): boolean {
    return /\b(?:permissions?|external_directory|denied|confirmation|approve|allow|ask)\b/i.test(text);
}

function classify(result: Omit<RunResult, 'classification' | 'pass'>): RunResult['classification'] {
    if (result.stderrPermissionHit || result.stdoutPermissionHit) return 'PERMISSION_FAILURE';
    if (result.exitCode !== 0 || result.signal) {
        return result.hasStepFinish ? 'TOOL_EXECUTION_FAILURE' : 'RUNTIME_STALL';
    }
    if (result.hasErrorEvent) return 'TOOL_EXECUTION_FAILURE';
    if (!result.fileExists || !result.markerFound) return 'TOOL_EXECUTION_FAILURE';
    if (!result.hasStepFinish) return 'RUNTIME_STALL';
    if (result.hasTextEvent && result.parserFullTextLength === 0) return 'PARSER_FAILURE';
    return 'PASS';
}

function parseEvents(stdout: string): { events: CliEventRecord[]; parseErrors: string[]; eventTypes: Record<string, number> } {
    const events: CliEventRecord[] = [];
    const parseErrors: string[] = [];
    const eventTypes: Record<string, number> = {};
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line) as CliEventRecord;
            events.push(parsed);
            const type = typeof parsed.type === 'string' ? parsed.type : 'unknown';
            eventTypes[type] = (eventTypes[type] || 0) + 1;
        } catch (error) {
            parseErrors.push(`${(error as Error).message}: ${line.slice(0, 200)}`);
        }
    }
    return { events, parseErrors, eventTypes };
}

function replayParser(events: CliEventRecord[]): { fullTextLength: number; liveTextLength: number } {
    const ctx: SpawnContext = {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false,
        sessionId: null,
        cost: null,
        turns: null,
        duration: null,
        tokens: null,
        stderrBuf: '',
        pendingOutputChunk: '',
        opencodePreToolText: '',
        opencodePostToolText: '',
        opencodeSawToolInStep: false,
        opencodeHadToolErrorInStep: false,
        opencodePendingToolRefs: [],
    };
    let liveText = '';
    for (const event of events) {
        extractFromEvent('opencode', event, ctx, 'opencode-smoke');
        liveText += extractOutputChunk('opencode', event, ctx);
    }
    return { fullTextLength: ctx.fullText.length, liveTextLength: liveText.length };
}

function runProcess(opencodeBinary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
}> {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(opencodeBinary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            resolve({ stdout, stderr: `${stderr}\n[TIMEOUT ${TIMEOUT_MS}ms]`, exitCode: null, signal: 'SIGTERM', durationMs: Date.now() - started });
        }, TIMEOUT_MS);

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr: `${stderr}\n[SPAWN_ERROR] ${error.message}`, exitCode: 127, signal: null, durationMs: Date.now() - started });
        });
        child.on('close', (exitCode, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode, signal: signal as NodeJS.Signals | null, durationMs: Date.now() - started });
        });
    });
}

async function runCase(testCase: SmokeCase, env: NodeJS.ProcessEnv, opencodeBinary: string): Promise<RunResult> {
    const caseRoot = join(tempRoot, testCase.id);
    const workDir = join(caseRoot, 'work');
    const externalDir = testCase.targetKind === 'jaw-like-external'
        ? join(os.homedir(), `.cli-jaw-smoke-${stamp}`, testCase.id, 'external')
        : join(caseRoot, 'external');
    const targetFile = join(externalDir, testCase.fileRel);
    const marker = `SMOKE_${testCase.id}_${stamp}`;
    const extraFiles = [join(externalDir, 'source-a.txt'), join(externalDir, 'nested', 'source-b.txt')];
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(externalDir, { recursive: true });
    testCase.seed?.(targetFile, marker, extraFiles);

    const prompt = testCase.prompt(targetFile, marker, extraFiles);
    const args = buildArgs('opencode', MODEL, '', prompt, '', 'auto');
    const stdoutFile = join(baseFixtureDir, `${testCase.id}.stdout.ndjson`);
    const stderrFile = join(baseFixtureDir, `${testCase.id}.stderr.log`);
    const resultFile = join(baseFixtureDir, `${testCase.id}.result.json`);
    const proc = await runProcess(opencodeBinary, args, workDir, env);
    fs.writeFileSync(stdoutFile, proc.stdout, 'utf8');
    fs.writeFileSync(stderrFile, proc.stderr, 'utf8');

    const { events, parseErrors, eventTypes } = parseEvents(proc.stdout);
    const parser = replayParser(events);
    const hasErrorEvent = events.some(event => event.type === 'error');
    const hasStepFinish = events.some(event => event.type === 'step_finish');
    const hasTextEvent = events.some(event => event.type === 'text');
    const fileExists = fs.existsSync(targetFile);
    const fileText = fileExists ? fs.readFileSync(targetFile, 'utf8') : '';
    const partial: Omit<RunResult, 'classification' | 'pass'> = {
        id: testCase.id,
        exitCode: proc.exitCode,
        signal: proc.signal,
        durationMs: proc.durationMs,
        cwd: workDir,
        externalDir,
        targetFile,
        marker,
        stdoutFile,
        stderrFile,
        resultFile,
        eventCount: events.length,
        eventTypes,
        parseErrors,
        stderrPermissionHit: permissionHit(proc.stderr),
        stdoutPermissionHit: permissionHit(proc.stdout),
        hasErrorEvent,
        hasStepFinish,
        hasTextEvent,
        parserFullTextLength: parser.fullTextLength,
        parserLiveTextLength: parser.liveTextLength,
        fileExists,
        markerFound: fileText.includes(marker),
        notes: [],
    };
    if (parseErrors.length) partial.notes.push('stdout had non-JSON lines');
    if (!partial.markerFound) partial.notes.push('expected marker missing from target file');
    const classification = classify(partial);
    const result: RunResult = { ...partial, classification, pass: classification === 'PASS' };
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
}

async function main(): Promise<void> {
    fs.mkdirSync(baseFixtureDir, { recursive: true });
    ensureOpencodeAlwaysAllowPermissions();
    const env = {
        ...process.env,
        ...applyCliEnvDefaults('opencode', {}, process.env),
    } as NodeJS.ProcessEnv;
    const opencodeBinary = resolveOpencodeBinary(env);
    const version = readOpencodeVersion(opencodeBinary, env);
    const selectedCases = cases.slice(0, RUNS);
    const summary = {
        model: MODEL,
        runsRequested: RUNS,
        timeoutMs: TIMEOUT_MS,
        fixtureDir: baseFixtureDir,
        tempRoot,
        opencodePath: opencodeBinary,
        opencodeVersion: version,
        argsPreview: buildArgs('opencode', MODEL, '', '<prompt>', '', 'auto').slice(0, -1),
        results: [] as RunResult[],
    };

    for (const testCase of selectedCases) {
        console.log(`[opencode-smoke] ${testCase.id} start`);
        const result = await runCase(testCase, env, opencodeBinary);
        summary.results.push(result);
        console.log(`[opencode-smoke] ${testCase.id} ${result.classification} ${result.durationMs}ms`);
    }

    fs.writeFileSync(join(baseFixtureDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    const failed = summary.results.filter(result => !result.pass);
    console.log(`[opencode-smoke] fixtureDir=${baseFixtureDir}`);
    console.log(`[opencode-smoke] pass=${summary.results.length - failed.length} fail=${failed.length}`);
    if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
    console.error('[opencode-smoke] fatal:', error);
    process.exitCode = 1;
});
