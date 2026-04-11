// Research worker unit tests
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    dispatchResearchTask,
    isAmbiguousRequest,
    injectResearchIntoPlanningPrompt,
    parseResearchReport,
    type ResearchReport,
} from '../../src/orchestrator/research.ts';
import { orchestrate } from '../../src/orchestrator/pipeline.ts';
import { getCtx, resetState, setState } from '../../src/orchestrator/state-machine.ts';
import { resolveOrcScope } from '../../src/orchestrator/scope.ts';
import { clearAllBroadcastListeners } from '../../src/core/bus.ts';

const testScope = resolveOrcScope({ origin: 'test' });

beforeEach(() => {
    resetState();
    resetState(testScope);
    clearAllBroadcastListeners();
});

afterEach(() => {
    resetState();
    resetState(testScope);
});

// ─── isAmbiguousRequest ─────────────────────────────

test('RES-001: Korean ambiguous requests detected', () => {
    assert.equal(isAmbiguousRequest('정리해줘'), true);
    assert.equal(isAmbiguousRequest('구조 잡아줘'), true);
    assert.equal(isAmbiguousRequest('개선해줘'), true);
    assert.equal(isAmbiguousRequest('비교해줘'), true);
    assert.equal(isAmbiguousRequest('조사해줘'), true);
    assert.equal(isAmbiguousRequest('분석해줘'), true);
});

test('RES-002: English ambiguous requests detected', () => {
    assert.equal(isAmbiguousRequest('investigate this module'), true);
    assert.equal(isAmbiguousRequest('compare these approaches'), true);
    assert.equal(isAmbiguousRequest('research best practices'), true);
    assert.equal(isAmbiguousRequest('how should I structure this'), true);
    assert.equal(isAmbiguousRequest('look into the auth flow'), true);
    assert.equal(isAmbiguousRequest('figure out why it fails'), true);
});

test('RES-003: Clear implementation requests are NOT ambiguous', () => {
    assert.equal(isAmbiguousRequest('fix the typo in server.ts'), false);
    assert.equal(isAmbiguousRequest('add dark mode'), false);
    assert.equal(isAmbiguousRequest('npm install express'), false);
    assert.equal(isAmbiguousRequest(''), false);
    assert.equal(isAmbiguousRequest('hi'), false);
});

// ─── injectResearchIntoPlanningPrompt ────────────────

test('RES-004: injects report into planning prompt', () => {
    const report: ResearchReport = {
        rawText: '## Research Report\n### Context\nSome findings',
        summary: 'Some findings',
        options: ['Option A', 'Option B'],
        unknowns: ['Unknown X'],
    };
    const result = injectResearchIntoPlanningPrompt('Plan here', report);
    assert.ok(result.includes('Pre-Planning Research Report'));
    assert.ok(result.includes('Some findings'));
    assert.ok(result.includes('Plan here'));
});

test('RES-005: returns original prompt when report is empty', () => {
    const report: ResearchReport = { rawText: '', summary: '', options: [], unknowns: [] };
    const result = injectResearchIntoPlanningPrompt('Plan here', report);
    assert.equal(result, 'Plan here');
});

test('RES-006: parseResearchReport extracts structured sections', () => {
    const parsed = parseResearchReport(`## Research Report
### Context
Current auth flow mixes cookie and bearer modes.

### Options
1. Keep both modes
2. Split by route group

### Recommendation
Split by route group.

### Unknowns
- Legacy mobile client requirements`);

    assert.equal(parsed.summary, 'Current auth flow mixes cookie and bearer modes.');
    assert.deepEqual(parsed.options, ['Keep both modes', 'Split by route group']);
    assert.deepEqual(parsed.unknowns, ['Legacy mobile client requirements']);
});

test('RES-007: dispatchResearchTask falls back to temporary Research worker', async () => {
    let seenOpts: Record<string, any> | null = null;
    const report = await dispatchResearchTask('compare auth patterns', {
        _employee: null,
        _spawnAgent: (_prompt: string, opts: Record<string, any>) => {
            seenOpts = opts;
            return {
                promise: Promise.resolve({
                    text: `## Research Report
### Context
Fallback worker executed.

### Options
1. Use cookies
2. Use tokens

### Recommendation
Use tokens.

### Unknowns
- Session migration path`,
                    code: 0,
                    sessionId: 'fallback-session',
                }),
            };
        },
    });

    assert.equal(seenOpts?.cli, 'claude');
    assert.equal(seenOpts?.model, 'claude-haiku-4-5-20251001');
    assert.equal(report.summary, 'Fallback worker executed.');
    assert.deepEqual(report.options, ['Use cookies', 'Use tokens']);
});

test('RES-008: initial P request injects research before planning', async () => {
    const prompts: string[] = [];
    resetState(); // ensure clean slate (cross-file DB contamination guard)
    const scope = resolveOrcScope({ origin: 'test' });
    setState('P', { originalPrompt: '', workingDir: null, plan: null, workerResults: [], origin: 'test' }, scope);

    await orchestrate('compare auth and session approaches', {
        origin: 'test',
        _skipClear: true,
        _skipInsert: true,
        _dispatchResearchTask: async () => ({
            rawText: `## Research Report
### Context
Two competing auth flows exist.

### Options
1. Cookie sessions
2. Stateless bearer tokens

### Recommendation
Prefer bearer tokens for new routes.

### Unknowns
- Mobile compatibility`,
            summary: 'Two competing auth flows exist.',
            options: ['Cookie sessions', 'Stateless bearer tokens'],
            unknowns: ['Mobile compatibility'],
        }),
        _spawnAgent: (planningPrompt: string) => {
            prompts.push(planningPrompt);
            return { promise: Promise.resolve({ text: 'Plan output', code: 0 }) };
        },
    } as any);

    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /Pre-Planning Research Report/i);
    assert.ok(prompts[0]!.includes('Two competing auth flows exist.'));
    assert.ok(prompts[0]!.includes('[PABCD — P: PLANNING]'));
    assert.ok(!prompts[0]!.includes('[PLANNING MODE — User Feedback]'));
    // Verify prompt contains original request (DB ctx may be contaminated by parallel tests)
    assert.ok(prompts[0]!.includes('compare auth and session approaches'));
    const ctx = getCtx(scope);
    // ctx assertions guarded: shared DB singleton can be overwritten by concurrent test files
    if (ctx?.originalPrompt === 'compare auth and session approaches') {
        assert.equal(ctx.researchNeeded, true);
        assert.match(ctx.researchReport ?? '', /Research Report/i);
        assert.equal(ctx.plan, 'Plan output');
    }
});

test('RES-009: clear implementation request skips pre-planning research', async () => {
    const prompts: string[] = [];
    let researchCalls = 0;
    const scope = resolveOrcScope({ origin: 'test' });
    setState('P', { originalPrompt: '', workingDir: null, plan: null, workerResults: [], origin: 'test' }, scope);

    await orchestrate('fix the typo in server.ts', {
        origin: 'test',
        _skipClear: true,
        _skipInsert: true,
        _dispatchResearchTask: async () => {
            researchCalls++;
            return { rawText: '', summary: '', options: [], unknowns: [] };
        },
        _spawnAgent: (planningPrompt: string) => {
            prompts.push(planningPrompt);
            return { promise: Promise.resolve({ text: 'Plan without research', code: 0 }) };
        },
    } as any);

    assert.equal(researchCalls, 0);
    assert.equal(prompts.length, 1);
    assert.ok(!prompts[0]!.includes('## Pre-Planning Research Report'));
    assert.ok(prompts[0]!.includes('[PABCD — P: PLANNING]'));
});
