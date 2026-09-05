import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { NativeRunFailure, runNativeRuntime, type NativeRunHost, type NativeRunLease } from '../../src/agent/native-runtime-run.ts';
import type { NativeRuntimeSession } from '../../src/agent/runtime/session.ts';
import type { RuntimeEvent, RuntimeTurnOutcome } from '../../src/shared/runtime-contract.ts';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const final: RuntimeTurnOutcome = { status: 'done', finalText: 'FINAL', partialText: 'commentary FINAL' };
const stopped: RuntimeTurnOutcome = { status: 'stopped', finalText: null, partialText: 'accepted partial' };
const event: RuntimeEvent = { version: 1, runId: 'run-a', sessionId: 'chat-a', scope: 'scope-a',
    turnId: 'turn-a', seq: 1, kind: 'turn-start', provider: 'fixture' };
type Result = { answer: string | null; origin: 'settle' | 'failed' };

function fixture() {
    const log: string[] = [];
    const settled: Array<{ lease: NativeRunLease | null; outcome: RuntimeTurnOutcome; diagnostic: string | null }> = [];
    const failed: Array<{ error: unknown; lease: NativeRunLease | null; outcome: RuntimeTurnOutcome }> = [];
    const retireReasons: Error[] = [];
    let current = true;
    let signal: AbortSignal | undefined;
    let reusable = true;
    let emit: ((value: RuntimeEvent) => void) | undefined;
    const hooks = {
        acquire: async (): Promise<NativeRunLease> => lease,
        ready: (): void | (() => void) => () => { log.push('cleanup'); },
        send: async (): Promise<RuntimeTurnOutcome> => final,
        claim: (): RuntimeTurnOutcome | null => final,
        cancel: async (): Promise<void> => {},
        event: (): void => {},
        settle: async (outcome: RuntimeTurnOutcome): Promise<Result> => ({ answer: outcome.finalText, origin: 'settle' }),
        failed: async (outcome: RuntimeTurnOutcome): Promise<Result> => ({ answer: outcome.finalText, origin: 'failed' }),
        retire: async (): Promise<void> => {},
        release: (): void => {},
        finalized: (): void => {},
    };
    const session: NativeRuntimeSession = {
        alive: true, nativeSessionId: 'native-a',
        capabilities: { transport: 'native', steer: 'cancel-reprompt', resume: true, tools: true,
            toolOutput: true, approvals: false, questions: false, images: false, subagents: false },
        send: async (prompt, observer) => {
            log.push('send'); assert.equal(prompt.text, 'PROMPT'); emit = observer;
            return hooks.send();
        },
        claimTurnOutcome: id => { log.push('claim'); assert.equal(id, 'turn-a'); return hooks.claim(); },
        finalizeTurn: () => { log.push('finalizeTurn'); return true; },
        cancel: async () => { log.push('cancel'); await hooks.cancel(); },
        steer: async () => { throw new Error('unexpected steer'); },
        respond: async () => { throw new Error('unexpected respond'); },
        close: async () => { throw new Error('host must retire through the lease'); },
    };
    const lease: NativeRunLease = {
        child: new ChildProcess(), session,
        release: () => { log.push('release'); hooks.release(); },
        retire: reason => {
            log.push('retire'); reusable = false; retireReasons.push(reason);
            return hooks.retire();
        },
    };
    const host: NativeRunHost<Result> = {
        prompt: { text: 'PROMPT' }, turnId: 'turn-a',
        acquire: async value => { log.push('acquire'); signal = value; return hooks.acquire(); },
        isCurrent: () => current,
        ready: value => { log.push('ready'); assert.equal(value, lease); return hooks.ready(); },
        event: value => { log.push('event'); assert.equal(value, event); hooks.event(); },
        settle: async (value, outcome, diagnostic) => {
            log.push('settle'); settled.push({ lease: value, outcome, diagnostic }); return hooks.settle(outcome);
        },
        failed: async (error, value, outcome) => {
            log.push('failed'); failed.push({ error, lease: value, outcome }); return hooks.failed(outcome);
        },
        finalized: () => { log.push('finalized'); hooks.finalized(); },
    };
    return { host, hooks, lease, log, settled, failed, retireReasons, emit: () => emit!(event),
        setCurrent: (value: boolean) => { current = value; }, signal: () => signal, reusable: () => reusable };
}

test.beforeEach(() => { mock.method(console, 'warn', () => {}); });
test.afterEach(() => { mock.restoreAll(); });

test('prestart cancel skips acquire; queued start lets caller install hooks first', async () => {
    const f = fixture();
    const run = runNativeRuntime(f.host);
    assert.deepEqual(f.log, []);
    run.cancel(); run.cancel();
    assert.deepEqual(await run.done, { answer: null, origin: 'settle' });
    assert.deepEqual(f.log, ['settle', 'finalized']);
    assert.equal(f.settled[0]!.lease, null);
    assert.deepEqual(f.settled[0]!.outcome, { status: 'stopped', finalText: null, partialText: '' });
});

test('stale before acquisition never requests a lease', async () => {
    const f = fixture(); f.setCurrent(false);
    await runNativeRuntime(f.host).done;
    assert.deepEqual(f.log, ['settle', 'finalized']);
});

for (const reason of ['cancel', 'replacement'] as const) {
    test(`late acquisition after ${reason} never attaches or prompts and retires only its lease`, async () => {
        const f = fixture(); const acquired = deferred<NativeRunLease>(); const entered = deferred<void>();
        f.hooks.acquire = () => { entered.resolve(); return acquired.promise; };
        const run = runNativeRuntime(f.host); await entered.promise;
        if (reason === 'cancel') { run.cancel('stop'); assert.equal(f.signal()!.aborted, true); }
        else f.setCurrent(false);
        acquired.resolve(f.lease); await run.done;
        assert.equal(f.log.includes('ready'), false); assert.equal(f.log.includes('send'), false);
        assert.equal(f.log.includes('cancel'), false);
        assert.ok(f.log.indexOf('retire') < f.log.indexOf('release'));
        assert.equal(f.settled[0]!.lease, f.lease); assert.equal(f.reusable(), false);
    });
}

for (const method of ['claimTurnOutcome', 'finalizeTurn'] as const) {
    test(`missing ${method} fails before ready/send`, async () => {
        const f = fixture(); delete f.lease.session[method];
        await runNativeRuntime(f.host).done;
        assert.equal(f.log.includes('ready'), false); assert.equal(f.log.includes('send'), false);
        assert.equal(f.failed.length, 1); assert.equal(f.reusable(), false);
    });
}

test('ready reentrant cancel is latched once and checked before prompt', async () => {
    const f = fixture(); let run: ReturnType<typeof runNativeRuntime<Result>>;
    f.hooks.ready = () => { run.cancel(); return () => { f.log.push('cleanup'); run.cancel(); }; };
    f.hooks.cancel = async () => { run.cancel(); };
    run = runNativeRuntime(f.host); await run.done;
    assert.equal(f.log.filter(x => x === 'cancel').length, 1);
    assert.equal(f.log.includes('send'), false); assert.equal(f.settled.length, 1);
    assert.equal(f.log.filter(x => x === 'cleanup').length, 1);
});

test('ready replacement is checked before prompt', async () => {
    const f = fixture(); f.hooks.ready = () => { f.setCurrent(false); return () => { f.log.push('cleanup'); }; };
    await runNativeRuntime(f.host).done;
    assert.equal(f.log.includes('send'), false); assert.equal(f.reusable(), false);
});

for (const stage of ['acquire', 'ready', 'send', 'claim'] as const) {
    test(`${stage} exception is reported once and every acquired resource is finalized`, async () => {
        const f = fixture(); f.hooks[stage] = () => { throw new Error(stage); };
        await runNativeRuntime(f.host).done;
        assert.equal(f.failed.length, 1); assert.equal(f.settled.length, 0);
        assert.equal(f.log.filter(x => x === 'send').length, stage === 'send' || stage === 'claim' ? 1 : 0);
        assert.equal(f.log.at(-1), 'finalized');
        assert.equal(f.log.filter(x => x === 'release').length, stage === 'acquire' ? 0 : 1);
        if (stage === 'send') assert.deepEqual(f.failed[0]!.outcome, { status: 'error', finalText: null, partialText: '' });
        if (stage === 'claim') assert.deepEqual(f.failed[0]!.outcome, { status: 'error', finalText: null, partialText: final.partialText });
    });
}

test('isCurrent exception still reaches failed and finalized', async () => {
    const f = fixture(); f.host.isCurrent = () => { throw new Error('owner read'); };
    await runNativeRuntime(f.host).done;
    assert.deepEqual(f.log, ['failed', 'finalized']);
});

test('present claim returning null is not a send-result fallback', async () => {
    const f = fixture(); f.hooks.claim = () => null;
    assert.deepEqual(await runNativeRuntime(f.host).done, { answer: null, origin: 'settle' });
    assert.deepEqual(f.settled[0]!.outcome, { status: 'error', finalText: null, partialText: final.partialText });
    assert.equal(f.settled[0]!.diagnostic, 'Native runtime outcome claim failed');
    assert.equal(f.reusable(), false);
});

test('cancel during send waits for captured cancel before claim and preserves accepted partial', async () => {
    const f = fixture(); const sent = deferred<RuntimeTurnOutcome>(); const cancelGate = deferred<void>();
    const entered = deferred<void>(); const cancelling = deferred<void>();
    f.hooks.send = () => { entered.resolve(); return sent.promise; };
    f.hooks.cancel = () => { cancelling.resolve(); return cancelGate.promise; };
    f.hooks.claim = () => stopped;
    const run = runNativeRuntime(f.host); await entered.promise;
    run.cancel(); await cancelling.promise; sent.resolve(final);
    await Promise.resolve(); assert.equal(f.log.includes('claim'), false);
    cancelGate.resolve(); await run.done;
    assert.deepEqual(f.settled[0]!.outcome, stopped);
    assert.ok(f.log.indexOf('cancel') < f.log.indexOf('claim'));
});

test('passive claim survives owner removal; postclaim outcome cannot change', async () => {
    const f = fixture(); const candidate = { ...final }; let run: ReturnType<typeof runNativeRuntime<Result>>;
    f.hooks.send = async () => { f.setCurrent(false); return final; };
    f.hooks.claim = () => candidate;
    f.hooks.cancel = async () => { candidate.status = 'error'; candidate.finalText = null; };
    f.hooks.settle = async outcome => { run.cancel(); await Promise.resolve(); return { answer: outcome.finalText, origin: 'settle' }; };
    run = runNativeRuntime(f.host);
    assert.deepEqual(await run.done, { answer: 'FINAL', origin: 'settle' });
    assert.equal(f.settled[0]!.outcome.status, 'done'); assert.ok(Object.isFrozen(f.settled[0]!.outcome));
});

test('event throws never reject send or lose final; late and stale callbacks are suppressed', async () => {
    const f = fixture();
    f.hooks.event = () => { throw new Error('private observer text'); };
    f.hooks.send = async () => { f.emit(); f.emit(); return final; };
    assert.deepEqual(await runNativeRuntime(f.host).done, { answer: 'FINAL', origin: 'settle' });
    assert.equal(f.settled[0]!.diagnostic, 'Native runtime event observer failed');
    assert.equal(f.failed.length, 1); f.emit(); assert.equal(f.log.filter(x => x === 'event').length, 2);
    const stale = fixture(); stale.hooks.send = async () => { stale.setCurrent(false); stale.emit(); return final; };
    await runNativeRuntime(stale.host).done; assert.equal(stale.log.includes('event'), false);
});

test('settle failure invokes failed once, never retries lifecycle, and retains claimed outcome on rejection', async () => {
    const f = fixture();
    f.hooks.settle = async () => { throw new Error('terminal already attempted'); };
    f.hooks.failed = async () => { throw new Error('diagnostic rejected'); };
    await assert.rejects(runNativeRuntime(f.host).done, error => {
        assert.ok(error instanceof NativeRunFailure); assert.deepEqual(error.outcome, final);
        assert.ok(error.cause instanceof AggregateError); return true;
    });
    assert.equal(f.settled.length, 1); assert.equal(f.failed.length, 1);
    assert.deepEqual(f.log.slice(-4), ['cleanup', 'retire', 'release', 'finalized']);
});

test('failed returns a real R when settle throws', async () => {
    const f = fixture(); f.hooks.settle = async () => { throw new Error('settle'); };
    assert.deepEqual(await runNativeRuntime(f.host).done, { answer: 'FINAL', origin: 'failed' });
    assert.equal(f.settled.length, 1); assert.equal(f.failed.length, 1);
});

test('cancellation rejection is observed, quarantined and does not replace the claimed result', async () => {
    const f = fixture(); let run: ReturnType<typeof runNativeRuntime<Result>>;
    f.hooks.send = async () => { run.cancel(); return final; };
    f.hooks.cancel = async () => { throw new Error('cancel rejected'); };
    run = runNativeRuntime(f.host); assert.deepEqual(await run.done, { answer: 'FINAL', origin: 'settle' });
    assert.equal(f.reusable(), false); assert.equal(f.failed.length, 1); assert.equal(f.settled.length, 1);
});

for (const mode of ['throw', 'reject'] as const) {
    test(`cleanup ${mode} is observed before release even when retire also rejects`, async () => {
        const f = fixture();
        f.hooks.ready = () => () => {
            f.log.push('cleanup');
            if (mode === 'throw') throw new Error('cleanup');
            return Promise.reject(new Error('cleanup'));
        };
        f.hooks.retire = async () => { throw new Error('retire rejected'); };
        f.hooks.failed = async () => { throw new Error('failed rejected'); };
        assert.deepEqual(await runNativeRuntime(f.host).done, { answer: 'FINAL', origin: 'settle' });
        assert.deepEqual(f.log.slice(-5), ['cleanup', 'failed', 'retire', 'release', 'finalized']);
        assert.equal(f.reusable(), false); assert.equal(f.settled.length, 1); assert.equal(f.failed.length, 1);
    });
}

for (const stage of ['release', 'finalized'] as const) {
    test(`${stage} throw preserves R and attempts exact retirement/final cleanup`, async () => {
        const f = fixture(); f.hooks[stage] = () => { throw new Error(stage); };
        assert.deepEqual(await runNativeRuntime(f.host).done, { answer: 'FINAL', origin: 'settle' });
        assert.equal(f.log.filter(x => x === 'release').length, 1);
        assert.equal(f.log.filter(x => x === 'finalized').length, 1);
        assert.equal(f.retireReasons.length, 1); assert.equal(f.failed.length, 1);
    });
}

test('every exceptional stage can fail together without skipping the next stage', async () => {
    const f = fixture(); let run: ReturnType<typeof runNativeRuntime<Result>>;
    f.hooks.send = async () => { run.cancel(); return final; };
    f.hooks.cancel = async () => { throw new Error('cancel'); };
    f.hooks.settle = async () => { throw new Error('settle'); };
    f.hooks.failed = () => { throw new Error('failed'); };
    f.hooks.ready = () => () => { f.log.push('cleanup'); throw new Error('cleanup'); };
    f.hooks.retire = () => { throw new Error('retire'); };
    f.hooks.release = () => { throw new Error('release'); };
    f.hooks.finalized = () => { throw new Error('finalized'); };
    run = runNativeRuntime(f.host);
    await assert.rejects(run.done, error => {
        assert.ok(error instanceof NativeRunFailure); assert.deepEqual(error.outcome, final);
        assert.ok(error.cause instanceof AggregateError); assert.equal(error.cause.errors.length, 7); return true;
    });
    for (const stage of ['cancel', 'settle', 'failed', 'cleanup', 'retire', 'release', 'finalized']) {
        assert.equal(f.log.filter(value => value === stage).length, 1, stage);
    }
});

test('release waits for both settlement and async owned cleanup; cleanup reentrant cancel is observed', async () => {
    const f = fixture(); const settlement = deferred<Result>(); const cleanup = deferred<void>();
    const settling = deferred<void>(); const cleaning = deferred<void>(); const cancelGate = deferred<void>();
    const cancelling = deferred<void>(); let run: ReturnType<typeof runNativeRuntime<Result>>;
    f.hooks.settle = () => { settling.resolve(); return settlement.promise; };
    f.hooks.ready = () => () => { f.log.push('cleanup'); cleaning.resolve(); run.cancel(); return cleanup.promise; };
    f.hooks.cancel = () => { cancelling.resolve(); return cancelGate.promise; };
    run = runNativeRuntime(f.host); await settling.promise;
    assert.equal(f.log.includes('release'), false); assert.equal(f.log.includes('cleanup'), false);
    const value: Result = { answer: 'policy-selected', origin: 'settle' };
    settlement.resolve(value); await cleaning.promise; await cancelling.promise;
    cleanup.resolve(); await Promise.resolve(); assert.equal(f.log.includes('release'), false);
    cancelGate.resolve(); assert.equal(await run.done, value);
    run.cancel(); assert.equal(f.log.filter(x => x === 'cancel').length, 1);
});

test('nonsettling cleanup times out and quarantines; its later rejection stays observed', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(); const cleanup = deferred<void>(); const entered = deferred<void>();
    f.hooks.ready = () => () => { entered.resolve(); return cleanup.promise; };
    const run = runNativeRuntime(f.host); await entered.promise;
    t.mock.timers.tick(5_000);
    assert.deepEqual(await run.done, { answer: 'FINAL', origin: 'settle' });
    assert.equal(f.reusable(), false); assert.equal(f.log.filter(x => x === 'release').length, 1);
    cleanup.reject(new Error('late cleanup rejection')); await Promise.resolve();
});

test('cancelled acquire rejection produces stopped failure with no borrowed partial', async () => {
    const f = fixture(); const acquired = deferred<NativeRunLease>(); const entered = deferred<void>();
    f.hooks.acquire = () => { entered.resolve(); return acquired.promise; };
    const run = runNativeRuntime(f.host); await entered.promise;
    f.signal()!.addEventListener('abort', () => run.cancel());
    run.cancel(); acquired.reject(new Error('acquire aborted'));
    await run.done;
    assert.deepEqual(f.failed[0]!.outcome, { status: 'stopped', finalText: null, partialText: '' });
    assert.deepEqual(f.log, ['acquire', 'failed', 'finalized']);
});

test('settled native error/stopped outcomes remain semantic results, not thrown admission failures', async () => {
    for (const status of ['error', 'stopped'] as const) {
        const f = fixture(); const value = { ...stopped, status };
        f.hooks.send = async () => value; f.hooks.claim = () => value;
        await runNativeRuntime(f.host).done;
        assert.deepEqual(f.settled[0]!.outcome, value); assert.equal(f.failed.length, 0);
        assert.equal(f.log.filter(x => x === 'send').length, 1);
    }
});

test('late stop plus thrown lifecycle preserves even an empty claimed done outcome in typed rejection', async () => {
    const f = fixture(); let run: ReturnType<typeof runNativeRuntime<Result>>;
    const value: RuntimeTurnOutcome = { status: 'done', finalText: null, partialText: '' };
    f.hooks.send = async () => value; f.hooks.claim = () => value;
    f.hooks.settle = async () => { run.cancel(); throw new Error('postclaim lifecycle'); };
    f.hooks.failed = async () => { throw new Error('postclaim failed'); };
    run = runNativeRuntime(f.host);
    await assert.rejects(run.done, error => {
        assert.ok(error instanceof NativeRunFailure); assert.deepEqual(error.outcome, value); return true;
    });
});

test('turn identity is captured before queued acquire; release/finalized cannot cancel a successor', async () => {
    const f = fixture(); let run: ReturnType<typeof runNativeRuntime<Result>>;
    f.hooks.release = () => run.cancel(); f.hooks.finalized = () => run.cancel();
    run = runNativeRuntime(f.host); f.host.turnId = 'successor';
    await run.done; assert.equal(f.log.includes('cancel'), false);
});

test('a valid undefined R is not replaced by a fabricated fallback', async () => {
    const f = fixture();
    const run = runNativeRuntime<undefined>({ ...f.host, settle: async () => undefined,
        failed: () => { throw new Error('must not need fallback'); } });
    assert.equal(await run.done, undefined);
});

test('nonsettling cancellation times out before claim and later rejection is observed', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(); const cancellation = deferred<void>(); const entered = deferred<void>();
    let run: ReturnType<typeof runNativeRuntime<Result>>;
    f.hooks.send = async () => { run.cancel(); return final; };
    f.hooks.cancel = () => { entered.resolve(); return cancellation.promise; };
    run = runNativeRuntime(f.host); await entered.promise;
    t.mock.timers.tick(5_000); await run.done;
    assert.equal(f.reusable(), false); assert.equal(f.settled.length, 1);
    cancellation.reject(new Error('late cancel rejection')); await Promise.resolve();
});

test('nonsettling retirement cannot skip release and finalized or lose settled R', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(); const retirement = deferred<void>(); const entered = deferred<void>();
    f.hooks.ready = () => () => { throw new Error('cleanup'); };
    f.hooks.retire = () => { entered.resolve(); return retirement.promise; };
    const run = runNativeRuntime(f.host); await entered.promise;
    assert.equal(f.reusable(), false); assert.equal(f.log.includes('release'), false);
    t.mock.timers.tick(6_000);
    assert.deepEqual(await run.done, { answer: 'FINAL', origin: 'settle' });
    assert.equal(f.log.filter(x => x === 'finalized').length, 1);
    retirement.reject(new Error('late reap rejection')); await Promise.resolve();
});

test('nonsettling failed port cannot prevent teardown or cause an untyped done rejection', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(); const failure = deferred<Result>(); const entered = deferred<void>();
    f.hooks.settle = async () => { throw new Error('settle'); };
    f.hooks.failed = () => { entered.resolve(); return failure.promise; };
    const run = runNativeRuntime(f.host); const rejection = assert.rejects(run.done, NativeRunFailure);
    await entered.promise; t.mock.timers.tick(5_000); await rejection;
    assert.deepEqual(f.log.slice(-4), ['cleanup', 'retire', 'release', 'finalized']);
    failure.reject(new Error('late failed rejection')); await Promise.resolve();
});

for (const value of [null, '', ' \n\t ', 'FINAL']) {
    test(`normal completion preserves exact final ${JSON.stringify(value)} and releases after lifecycle`, async () => {
        const f = fixture(); f.hooks.claim = () => ({ ...final, finalText: value });
        assert.deepEqual(await runNativeRuntime(f.host).done, { answer: value, origin: 'settle' });
        assert.deepEqual(f.log, ['acquire', 'ready', 'send', 'claim', 'settle', 'cleanup', 'release', 'finalized']);
        assert.equal(f.reusable(), true); assert.equal(f.failed.length, 0);
    });
}
