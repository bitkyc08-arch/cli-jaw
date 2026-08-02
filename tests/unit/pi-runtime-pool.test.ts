import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    killed = false;
}

class FakePiSession {
    child = new FakeChild();
    sessionId: string | null;
    abortEffective: boolean;
    abortCount = 0;
    killCount = 0;
    closeCount = 0;

    constructor(sessionId: string | null, abortEffective: boolean) {
        this.sessionId = sessionId;
        this.abortEffective = abortEffective;
    }

    get alive(): boolean { return !this.child.killed && this.child.exitCode === null; }
    async sendPrompt(message: string): Promise<{ text: string; stderr: string }> {
        this.sessionId ||= `session-${fakeSessions.length}`;
        return { text: message, stderr: '' };
    }
    async abort(): Promise<void> { this.abortCount += 1; }
    close(): void { this.closeCount += 1; this.die(); }
    kill(): void { this.killCount += 1; this.die(); }
    die(): void {
        if (this.child.exitCode !== null) return;
        this.child.exitCode = 1;
        this.child.killed = true;
        this.child.emit('exit', 1);
    }
}

const fakeSessions: FakePiSession[] = [];
let nextAbortEffective = true;
let nextAbortReject = false;
let lastSpawnOptions: Record<string, unknown> | null = null;

mock.module('../../src/agent/codex-app-client.js', {
    namedExports: {
        CodexAppClient: class {},
        isRecoverableResumeError: () => false,
    },
});
mock.module('../../src/agent/pi-runtime.js', {
    namedExports: {
        normalizePiSettings: (input: unknown) => input,
        spawnPersistentPiRpc: (_profile: unknown, _settings: unknown, options: Record<string, unknown>) => {
            lastSpawnOptions = options;
            const session = new FakePiSession((options['sessionId'] as string | undefined) ?? null, nextAbortEffective);
            if (nextAbortReject) session.abort = async () => { session.abortCount += 1; throw new Error('abort transport failed'); };
            fakeSessions.push(session);
            return session;
        },
    },
});

const { acquirePiRuntime } = await import('../../src/agent/runtime-pool.js');

let sequence = 1;
function options(overrides: Record<string, unknown> = {}) {
    const scopeKey = String(overrides['scopeKey'] ?? `pi-scope-${sequence++}`);
    return {
        key: {
            scopeKey,
            cwd: '/tmp/pi-pool',
            profileId: 'progrok',
            fullEndpoint: String(overrides['fullEndpoint'] ?? 'http://127.0.0.1:18645/v1'),
            apiKind: String(overrides['apiKind'] ?? 'openai-completions'),
            model: String(overrides['model'] ?? 'model-a'),
            effort: String(overrides['effort'] ?? 'medium'),
            profileFp: String(overrides['profileFp'] ?? 'fp-a'),
        },
        piSettings: {
            defaultProfileId: 'progrok',
            profiles: [{ id: 'progrok' }],
        },
        ...(overrides['storedSessionId'] === undefined ? {} : { storedSessionId: overrides['storedSessionId'] }),
    };
}

test('Pi pool reuses a released live runtime', async () => {
    const scopeKey = `reuse-${sequence++}`;
    const first = await acquirePiRuntime(options({ scopeKey }));
    const session = first.session as unknown as FakePiSession;
    await first.session.sendPrompt('one');
    first.release();
    const second = await acquirePiRuntime(options({ scopeKey, storedSessionId: session.sessionId }));
    assert.equal(second.reused, true);
    assert.equal(second.session.child, first.session.child);
    second.release();
    session.die();
});

test('dead Pi runtime is recreated with stored --session-id resume input', async () => {
    const scopeKey = `dead-${sequence++}`;
    const first = await acquirePiRuntime(options({ scopeKey }));
    const old = first.session as unknown as FakePiSession;
    await first.session.sendPrompt('one');
    const storedSessionId = old.sessionId;
    first.release();
    old.die();
    const second = await acquirePiRuntime(options({ scopeKey, storedSessionId }));
    assert.notEqual(second.session.child, first.session.child);
    assert.equal(lastSpawnOptions?.['sessionId'], storedSessionId);
    second.release();
    (second.session as unknown as FakePiSession).die();
});

test('Pi key mutations replace endpoint path, api kind, model, effort, and credential fingerprint', async () => {
    const scopeKey = `mutate-${sequence++}`;
    const variants = [
        {},
        { fullEndpoint: 'http://127.0.0.1:18645/v2' },
        { fullEndpoint: 'http://127.0.0.1:18645/v2', apiKind: 'openai-responses' },
        { fullEndpoint: 'http://127.0.0.1:18645/v2', apiKind: 'openai-responses', model: 'model-b' },
        { fullEndpoint: 'http://127.0.0.1:18645/v2', apiKind: 'openai-responses', model: 'model-b', effort: 'high' },
        { fullEndpoint: 'http://127.0.0.1:18645/v2', apiKind: 'openai-responses', model: 'model-b', effort: 'high', profileFp: 'fp-rotated' },
    ];
    const children = [];
    for (const variant of variants) {
        const lease = await acquirePiRuntime(options({ scopeKey, ...variant }));
        children.push(lease.session.child);
        lease.release();
    }
    assert.equal(new Set(children).size, variants.length);
    (fakeSessions.at(-1))?.die();
});

test('Pi pool cancellation falls back to kill when abort support is false', async () => {
    nextAbortEffective = false;
    const lease = await acquirePiRuntime(options());
    const session = lease.session as unknown as FakePiSession;
    await lease.cancel();
    assert.equal(session.abortCount, 0);
    assert.equal(session.killCount, 1);
    lease.release();
    nextAbortEffective = true;
});

test('Pi pool cancellation falls back to kill when an effective abort rejects', async () => {
    nextAbortReject = true;
    const lease = await acquirePiRuntime(options());
    const session = lease.session as unknown as FakePiSession;
    await lease.cancel();
    assert.equal(session.abortCount, 1);
    assert.equal(session.killCount, 1);
    lease.release();
    nextAbortReject = false;
});
