import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcRoot = join(__dirname, '../../src');

const gatewaySrc = fs.readFileSync(join(srcRoot, 'orchestrator/gateway.ts'), 'utf8');
const pipelineSrc = fs.readFileSync(join(srcRoot, 'orchestrator/pipeline.ts'), 'utf8');
const spawnSrc = fs.readFileSync(join(srcRoot, 'agent/spawn.ts'), 'utf8');
const botSrc = fs.readFileSync(join(srcRoot, 'telegram/bot.ts'), 'utf8');

// ─── DI-001: gateway idle → orchestrate with _skipInsert ───

test('DI-001: gateway idle path passes _skipInsert: true to orchestrate', () => {
    // The idle path calls orchestrate after insertMessage — must tell downstream to skip
    const idleBlock = gatewaySrc.slice(gatewaySrc.indexOf('// ── idle'));
    assert.ok(
        idleBlock.includes('_skipInsert: true'),
        'idle path orchestrate call must include _skipInsert: true',
    );
});

// ─── DI-002: gateway continue → orchestrateContinue with _skipInsert ───

test('DI-002: gateway continue path passes _skipInsert: true to orchestrateContinue', () => {
    const continueBlock = gatewaySrc.slice(
        gatewaySrc.indexOf('// ── continue'),
        gatewaySrc.indexOf('// ── reset'),
    );
    assert.ok(
        continueBlock.includes('orchestrateContinue(') && continueBlock.includes('_skipInsert: true'),
        'continue path orchestrateContinue call must include _skipInsert: true',
    );
});

// ─── DI-003: gateway reset → orchestrateReset with _skipInsert ───

test('DI-003: gateway reset path passes _skipInsert: true to orchestrateReset', () => {
    const resetBlock = gatewaySrc.slice(
        gatewaySrc.indexOf('// ── reset'),
        gatewaySrc.indexOf('// ── busy'),
    );
    assert.ok(
        resetBlock.includes('orchestrateReset(') && resetBlock.includes('_skipInsert: true'),
        'reset path orchestrateReset call must include _skipInsert: true',
    );
});

// ─── DI-004: pipeline triage spawnAgent propagates _skipInsert ───

test('DI-004: pipeline triage path propagates _skipInsert to spawnAgent', () => {
    // Find the triage block (employees.length > 0 && !needsOrchestration)
    const triageStart = pipelineSrc.indexOf('[jaw:triage] direct response');
    assert.ok(triageStart > 0, 'triage block must exist');
    const triageBlock = pipelineSrc.slice(triageStart, triageStart + 300);
    assert.ok(
        triageBlock.includes('_skipInsert: !!meta._skipInsert'),
        'triage spawnAgent must propagate _skipInsert from meta',
    );
});

// ─── DI-005: pipeline no-employees spawnAgent propagates _skipInsert ───

test('DI-005: pipeline no-employees path propagates _skipInsert to spawnAgent', () => {
    // Find the "직원 없으면 단일 에이전트 모드" block
    const noEmpStart = pipelineSrc.indexOf('직원 없으면 단일 에이전트 모드');
    assert.ok(noEmpStart > 0, 'no-employees block must exist');
    const noEmpBlock = pipelineSrc.slice(noEmpStart, noEmpStart + 300);
    assert.ok(
        noEmpBlock.includes('_skipInsert: !!meta._skipInsert'),
        'no-employees spawnAgent must propagate _skipInsert from meta',
    );
});

// ─── DI-006: bot.ts tgOrchestrate → orchestrateAndCollect with _skipInsert ───

test('DI-006: tgOrchestrate passes _skipInsert: true to orchestrateAndCollect', () => {
    const collectCall = botSrc.match(/orchestrateAndCollect\(prompt,\s*\{[^}]+\}\)/);
    assert.ok(collectCall, 'orchestrateAndCollect call must exist in bot.ts');
    assert.ok(
        collectCall[0].includes('_skipInsert: true'),
        'orchestrateAndCollect call must include _skipInsert: true',
    );
});

// ─── DI-007: spawn.ts processQueue → orchestrate with _skipInsert ───

test('DI-007: processQueue passes _skipInsert: true to orchestrate calls', () => {
    const pqStart = spawnSrc.indexOf('export async function processQueue');
    const pqEnd = spawnSrc.indexOf('// ─── Helpers', pqStart);
    const pqBlock = spawnSrc.slice(pqStart, pqEnd > 0 ? pqEnd : pqStart + 1500);
    // All 3 orchestrate calls in processQueue must have _skipInsert
    assert.ok(pqBlock.includes("orchestrateReset({ origin, chatId, _skipInsert: true })"), 'processQueue orchestrateReset');
    assert.ok(pqBlock.includes("orchestrateContinue({ origin, chatId, _skipInsert: true })"), 'processQueue orchestrateContinue');
    assert.ok(pqBlock.includes("orchestrate(combined, { origin, chatId, _skipInsert: true })"), 'processQueue orchestrate');
});

// ─── DI-008: spawn.ts steerAgent → orchestrate with _skipInsert ───

test('DI-008: steerAgent passes _skipInsert: true to orchestrate calls', () => {
    const steerStart = spawnSrc.indexOf('export async function steerAgent');
    const steerEnd = spawnSrc.indexOf('// ─── Message Queue', steerStart);
    const steerBlock = spawnSrc.slice(steerStart, steerEnd > 0 ? steerEnd : steerStart + 800);
    assert.ok(steerBlock.includes("orchestrateReset({ origin, _skipInsert: true })"), 'steerAgent orchestrateReset');
    assert.ok(steerBlock.includes("orchestrateContinue({ origin, _skipInsert: true })"), 'steerAgent orchestrateContinue');
    assert.ok(steerBlock.includes("orchestrate(newPrompt, { origin, _skipInsert: true })"), 'steerAgent orchestrate');
});

// ─── DI-009: processQueue retains its own insertMessage (existing behavior) ───

test('DI-009: processQueue still has its own insertMessage.run (not removed)', () => {
    const pqStart = spawnSrc.indexOf('export async function processQueue');
    const pqEnd = spawnSrc.indexOf('// ─── Helpers', pqStart);
    const pqBlock = spawnSrc.slice(pqStart, pqEnd > 0 ? pqEnd : pqStart + 1500);
    assert.ok(
        pqBlock.includes("insertMessage.run('user', combined, source, '')"),
        'processQueue must retain its own insertMessage call',
    );
});

// ─── DI-010: steerAgent retains its own insertMessage (existing behavior) ───

test('DI-010: steerAgent still has its own insertMessage.run (not removed)', () => {
    const steerStart = spawnSrc.indexOf('export async function steerAgent');
    const steerEnd = spawnSrc.indexOf('// ─── Message Queue', steerStart);
    const steerBlock = spawnSrc.slice(steerStart, steerEnd > 0 ? steerEnd : steerStart + 800);
    assert.ok(
        steerBlock.includes("insertMessage.run('user', newPrompt, source, '')"),
        'steerAgent must retain its own insertMessage call',
    );
});
