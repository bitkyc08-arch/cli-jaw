import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { log } from '../../src/core/logger.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(homedir(), '.cljaw-test-'));
process.env['CLI_JAW_HOME'] = home;
test.after(() => rmSync(home, { recursive: true, force: true }));

// initSlack/shutdownSlack lifecycle. Isolated in its own file because it mocks
// the socket client and the send path.

const state: {
    started: number;
    stopped: number;
    authOk: boolean;
    inspectKind: 'none' | 'foreign_live' | 'uncertain';
    acquireKind: 'acquired' | 'foreign_live' | 'unavailable';
    acquired: number;
    released: number;
    inspected: number;
    ready: 'connected' | 'timeout' | 'stopped';
    startThrows: boolean;
    claimConnected: boolean[];
    sockets: Array<{ emit(state: string): void }>;
    emitConnectedOnStart: boolean;
} = {
    started: 0, stopped: 0, authOk: true, inspectKind: 'none', acquireKind: 'acquired',
    acquired: 0, released: 0, inspected: 0, ready: 'connected', startThrows: false,
    claimConnected: [], sockets: [], emitConnectedOnStart: true,
};

mock.module('../../src/slack/token-claim.ts', {
    namedExports: {
        SLACK_TOKEN_CLAIM_FRESH_MS: 90_000,
        inspectSlackTokenClaim: () => {
            state.inspected++;
            return state.inspectKind === 'foreign_live'
                ? { kind: 'foreign_live', claim: { home: '/foreign', port: '9999', pid: 42, connected: true } }
                : state.inspectKind === 'uncertain' ? { kind: 'uncertain', error: 'realpath' }
                : { kind: 'none' };
        },
        acquireSlackTokenClaim: (options: { connected: boolean }) => {
            state.acquired++;
            state.claimConnected.push(options.connected);
            if (state.acquireKind === 'foreign_live') return { kind: 'foreign_live', claim: { home: '/foreign', port: '9999', pid: 42, connected: true } };
            if (state.acquireKind === 'unavailable') return { kind: 'unavailable', error: 'io' };
            let released = false;
            return { kind: 'acquired', lease: {
                claim: { claimId: String(state.acquired) },
                markConnected() { return 'ok' as const; }, markDisconnected() {},
                release() { if (!released) { released = true; state.released++; } },
            } };
        },
    },
});

mock.module('../../src/slack/api.ts', {
    namedExports: {
        slackApi: async (_token: string, method: string) => {
            if (method === 'auth.test') {
                return state.authOk
                    ? { ok: true, data: { user_id: 'UBOT', team_id: 'T1' } }
                    : { ok: false, error: 'invalid_auth' };
            }
            return { ok: true, data: {} };
        },
        describeSlackError: (e?: string) => e ?? 'unknown',
        redactSlackTokens: (s: string) => s,
        isRetryableSlackError: () => false,
        // inbound-file.ts imports this from the same module; a partial mock
        // that omits it makes the whole import graph fail to link.
        neededScopeFrom: () => '',
        // Same rule for the ACK/notice wrappers bot.ts pulls in (#412): every
        // named import in the graph has to exist here or nothing links.
        addSlackReaction: async () => ({ ok: true }),
        removeSlackReaction: async () => ({ ok: true }),
        deleteSlackMessage: async () => ({ ok: true }),
        updateSlackMessage: async () => ({ ok: true }),
        stripEmojiColons: (name: string) => name.replace(/^:+|:+$/g, ''),
        SLACK_CLEANUP_TIMEOUT_MS: 5000,
        // Auto-join reaches api.ts through bot.ts, so the same completeness
        // rule applies. An empty channel list makes the background scan a
        // no-op, which is what this file wants: it tests the lifecycle, not
        // the reconciliation.
        listSlackConversations: async () => ({ ok: true, data: { channels: [] } }),
        joinSlackConversation: async () => ({ ok: true, data: {} }),
        slackFailure: (error: string, status?: number) =>
            status === undefined ? { ok: false, error } : { ok: false, error, status },
    },
});

mock.module('../../src/slack/socket.ts', {
    namedExports: {
        HELLO_DEADLINE_MS: 15_000,
        SlackSocketClient: class {
            constructor(private options: { onStateChange?: (state: string) => void }) {
                state.sockets.push(this);
            }
            async start() {
                state.started++;
                if (state.startThrows) throw new Error('start failed');
                if (state.ready === 'connected' && state.emitConnectedOnStart) this.options.onStateChange?.('connected');
            }
            async waitForReady() { return state.ready; }
            stop() { state.stopped++; this.options.onStateChange?.('disconnected'); }
            getState() { return 'connected'; }
            getReconnectAttempts() { return 0; }
            emit(next: string) { this.options.onStateChange?.(next); }
        },
    },
});

async function loadBot(slack: Record<string, unknown>, port = '24575') {
    const { settings } = await import('../../src/core/config.ts');
    (settings as Record<string, unknown>)['port'] = port;
    (settings as Record<string, unknown>)['slack'] = slack;
    return import('../../src/slack/bot.ts');
}

function resetClaimState(): void {
    state.started = 0;
    state.stopped = 0;
    state.inspectKind = 'none';
    state.acquireKind = 'acquired';
    state.acquired = 0;
    state.released = 0;
    state.inspected = 0;
    state.ready = 'connected';
    state.startThrows = false;
    state.claimConnected = [];
    state.sockets = [];
    state.emitConnectedOnStart = true;
    delete process.env['CLI_JAW_SLACK_ALLOW_SHARED_TOKEN'];
}

test('initSlack actually starts the socket for a fully configured workspace', async () => {
    // Regression: initSlack claimed a lifecycle generation BEFORE calling
    // shutdownSlack, whose own bump then invalidated it — so every normal
    // start aborted after auth.test and Slack inbound never came up at all.
    state.started = 0;
    state.stopped = 0;
    state.authOk = true;

    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t' });
    await bot.initSlack();
    assert.equal(state.started, 1, 'the socket never started — init self-superseded');
    assert.equal(bot.getSlackSelfUserId(), 'UBOT', 'auth identity was not recorded');
    const { settings } = await import('../../src/core/config.ts');
    assert.equal(settings["slack"].attachPort, '24575', 'the first successful socket must elect itself');
    const persisted = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    assert.equal(persisted.slack.attachPort, '24575', 'the election must survive restart');

    await bot.shutdownSlack();
    assert.equal(state.stopped >= 1, true, 'shutdown did not stop the socket');
    assert.equal(bot.getSlackSelfUserId(), null);
});

test('an explicitly elected different port refuses before opening a socket', async () => {
    state.started = 0;
    const bot = await loadBot({
        enabled: true,
        botToken: 'xoxb-t',
        appToken: 'xapp-t',
        attachPort: '3457',
    });
    const outcome = await bot.initSlack();
    assert.equal(state.started, 0);
    assert.deepEqual(outcome, { started: false, reason: 'not_attach_instance' });
});

test('a competing election already on disk makes this instance yield its socket', async () => {
    state.started = 0;
    state.stopped = 0;
    // Simulate the other same-home process having persisted first: write the
    // file directly, leaving the in-memory copy (attachPort unset) stale, which
    // is exactly the state the disk re-read exists to catch.
    // saveSettings() REPLACES the exported settings binding (config.ts ~1289),
    // so writing through it would put 3457 in memory too and the guard would
    // refuse before the socket. Write the file directly instead.
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
        settingsSchemaVersion: 4, port: '24575',
        slack: { enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '3457' },
    }), 'utf8');
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '' }, '24575');
    const outcome = await bot.initSlack();
    assert.equal(state.started, 1, 'the provisional socket was opened');
    assert.equal(state.stopped >= 1, true, 'and disposed once the disk showed another owner');
    assert.deepEqual(outcome, { started: false, reason: 'not_attach_instance' });
    const persisted = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    assert.equal(persisted.slack.attachPort, '3457', 'the earlier election was not overwritten');
});

test('initSlack stays outbound-only without an app token', async () => {
    state.started = 0;
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: '' });
    await bot.initSlack();
    assert.equal(state.started, 0, 'inbound must not start without the app-level token');
});

test('initSlack does nothing when slack is disabled', async () => {
    state.started = 0;
    const bot = await loadBot({ enabled: false, botToken: 'xoxb-t', appToken: 'xapp-t' });
    await bot.initSlack();
    assert.equal(state.started, 0);
});

test('initSlack aborts cleanly on an auth failure', async () => {
    state.started = 0;
    state.authOk = false;
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-bad', appToken: 'xapp-t' });
    await bot.initSlack();
    assert.equal(state.started, 0, 'a failed auth.test must not open a socket');
    state.authOk = true;
});

test('shutdownSlack is safe to call when nothing is running', async () => {
    const bot = await loadBot({ enabled: false });
    await assert.doesNotReject(() => bot.shutdownSlack());
});

test('an external shutdown during init is not lost', async () => {
    // Regression: initSlack awaited its own teardown BEFORE claiming a
    // generation, so a shutdown landing in that window was overwritten and the
    // init resumed to start a transport the caller had already stopped.
    state.started = 0;
    state.stopped = 0;
    state.authOk = true;

    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t' });
    const pending = bot.initSlack();
    await bot.shutdownSlack();
    await pending;

    assert.equal(
        bot.getSlackSelfUserId(),
        null,
        'init resurrected the transport after an external shutdown',
    );
});

test('an init that arrives during another init is not discarded', async () => {
    // Regression: a rapid disable/re-enable sequence (init -> shutdown ->
    // init) dropped the final start because the second init returned early on
    // the lock while the first was aborting. Slack stayed off until something
    // else happened to call init again.
    state.started = 0;
    state.stopped = 0;
    state.authOk = true;

    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t' });
    const first = bot.initSlack();
    await bot.shutdownSlack();     // supersedes the first init
    const second = bot.initSlack(); // lands while the first is still unwinding
    await Promise.all([first, second]);

    assert.equal(
        bot.getSlackSelfUserId(),
        'UBOT',
        'the final init request was dropped and Slack stayed off',
    );
    assert.ok(state.started >= 1, 'no socket was ever started');
    await bot.shutdownSlack();
});

test('repeated inits settle without runaway recursion', async () => {
    state.started = 0;
    state.authOk = true;
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t' });
    await Promise.all([bot.initSlack(), bot.initSlack(), bot.initSlack()]);
    assert.ok(state.started <= 3, `init ran away: ${state.started} starts`);
    await bot.shutdownSlack();
});

test('a: claim IO unavailability fails open and starts the socket', async () => {
    resetClaimState(); state.acquireKind = 'unavailable';
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
    assert.deepEqual(await bot.initSlack(), { started: true });
    assert.equal(state.started, 1);
    await bot.shutdownSlack();
});

test('b: hello acquisition is released exactly once by shutdown', async () => {
    resetClaimState();
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
    await bot.initSlack();
    assert.deepEqual(state.claimConnected, [true]);
    await bot.shutdownSlack();
    assert.equal(state.released, 1);
});

test('c: positively connected foreign owner refuses before socket construction', async () => {
    resetClaimState(); state.inspectKind = 'foreign_live';
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
    const outcome = await bot.initSlack();
    assert.deepEqual(outcome, { started: false, reason: 'token_shared_other_home' });
    assert.equal(state.sockets.length, 0);
    await bot.shutdownSlack();
});

test('d: hello election loss stops once and returns the ownership reason', async () => {
    resetClaimState(); state.acquireKind = 'foreign_live';
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
    const outcome = await bot.initSlack({ startEpoch: 1 });
    assert.deepEqual(outcome, { started: false, reason: 'token_shared_other_home' });
    assert.equal(state.acquired, 1, 'init and hello must share one arbitration');
    assert.equal(state.stopped, 1, 'foreign result must be applied once');
    await bot.shutdownSlack();
});

test('e: socket start failure leaves no acquired lease', async () => {
    resetClaimState(); state.startThrows = true;
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
    await assert.rejects(() => bot.initSlack(), /start failed/);
    assert.equal(state.acquired, 0);
    await bot.shutdownSlack();
});

test('f: readiness timeout starts with a non-blocking presence record', async () => {
    resetClaimState(); state.ready = 'timeout';
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
    assert.deepEqual(await bot.initSlack({ startEpoch: 2 }), { started: true });
    assert.deepEqual(state.claimConnected, [false]);
    state.sockets.at(-1)!.emit('connected');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.acquired, 1, 'late hello promotes the owned presence lease');
    await bot.shutdownSlack();
});

test('g: a client stopped before readiness cannot be reported as started', async () => {
    resetClaimState(); state.ready = 'stopped';
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
    assert.deepEqual(await bot.initSlack({ startEpoch: 3 }), { started: false, reason: 'superseded' });
    assert.equal(state.acquired, 0);
    await bot.shutdownSlack();
});

test('h: self-election loss releases the acquired generation', async () => {
    resetClaimState();
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
        settingsSchemaVersion: 4, port: '24575',
        slack: { enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '3457' },
    }));
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '' }, '24575');
    assert.deepEqual(await bot.initSlack(), { started: false, reason: 'not_attach_instance' });
    assert.equal(state.released, 1);
    await bot.shutdownSlack();
});

test('i/o: late foreign hello revokes the activated epoch', async () => {
    resetClaimState(); state.ready = 'timeout'; state.acquireKind = 'unavailable';
    const runtime = await import('../../src/messaging/runtime.ts');
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
    runtime.__resetTransportRegistryForTests();
    runtime.registerTransport('slack', { init: ctx => bot.initSlack(ctx), shutdown: () => bot.shutdownSlack() });
    assert.deepEqual(await runtime.startMessagingTransport('slack'), { started: true });
    assert.equal(runtime.isMessagingTransportRunning('slack'), true);
    state.acquireKind = 'foreign_live';
    state.sockets.at(-1)!.emit('connected');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.isMessagingTransportRunning('slack'), false);
    assert.equal(runtime.getMessagingTransportNotice('slack'), 'token_shared_other_home');
    await bot.shutdownSlack();
    runtime.__resetTransportRegistryForTests();
});

test('j/p: disconnected and disabled terminal states release the owned lease once', async () => {
    for (const terminal of ['disconnected', 'disabled']) {
        resetClaimState();
        const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
        await bot.initSlack();
        state.sockets.at(-1)!.emit(terminal);
        assert.equal(state.released, 1, `${terminal} did not release`);
        await bot.shutdownSlack();
        assert.equal(state.released, 1, `${terminal} release was not idempotent`);
    }
});

test('k: environment opt-out logs once and skips ownership work across repeated init', async t => {
    resetClaimState(); process.env['CLI_JAW_SLACK_ALLOW_SHARED_TOKEN'] = '1';
    const notices: unknown[][] = [];
    const originalInfo = log.info.bind(log);
    t.mock.method(log, 'info', (...args: unknown[]) => {
        if (args[0] === '[slack] shared app-token ownership guard disabled by environment') notices.push(args);
        originalInfo(...args);
    });
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
    assert.deepEqual(await bot.initSlack(), { started: true });
    assert.deepEqual(await bot.initSlack(), { started: true });
    assert.equal(notices.length, 1);
    assert.equal(state.inspected, 0);
    assert.equal(state.acquired, 0);
    await bot.shutdownSlack();
    delete process.env['CLI_JAW_SLACK_ALLOW_SHARED_TOKEN'];
});

for (const [label, emitConnectedOnStart] of [
    ['init path first', false],
    ['hello callback first', true],
] as const) {
    test(`apply-once creates one unref re-check timer when ${label}`, async t => {
        resetClaimState();
        state.acquireKind = 'foreign_live';
        state.ready = 'connected';
        state.emitConnectedOnStart = emitConnectedOnStart;
        const originalSetTimeout = globalThis.setTimeout;
        let timers = 0;
        let unrefs = 0;
        t.mock.method(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
            if ((delay ?? 0) >= 90_000) {
                timers++;
                return { unref() { unrefs++; } } as unknown as ReturnType<typeof setTimeout>;
            }
            return originalSetTimeout(callback, delay, ...args);
        }) as typeof setTimeout);
        const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
        assert.deepEqual(await bot.initSlack({ startEpoch: 91 }), {
            started: false,
            reason: 'token_shared_other_home',
        });
        assert.equal(timers, 1);
        assert.equal(unrefs, 1);
        await bot.shutdownSlack();
    });
}

test('m/n: hello before waiter and concurrent init arbitration acquire once', async () => {
    resetClaimState();
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
    await bot.initSlack();
    assert.equal(state.acquired, 1);
    await bot.shutdownSlack();
});

test('q: stale generation callback cannot release the newer lease', async () => {
    resetClaimState();
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t', attachPort: '24575' });
    await bot.initSlack();
    const old = state.sockets.at(-1)!;
    await bot.initSlack();
    const releasedAfterReplacement = state.released;
    old.emit('disconnected');
    assert.equal(state.released, releasedAfterReplacement);
    await bot.shutdownSlack();
});

test('l real lifecycle: late hello loses a replaced presence claim', async t => {
    const sharedHome = mkdtempSync(join(homedir(), '.cljaw-shared-'));
    const homeA = mkdtempSync(join(homedir(), '.cljaw-home-a-'));
    const homeB = mkdtempSync(join(homedir(), '.cljaw-home-b-'));
    const entry = join(import.meta.dirname!, '..', 'fixtures', 'slack-two-home-lifecycle.ts');
    const tsx = join(import.meta.dirname!, '..', '..', 'node_modules', '.bin', 'tsx');
    const children: ChildProcessWithoutNullStreams[] = [];
    const exited = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
    const rmQuiet = (path: string) => {
        // A child still winding down can recreate a lock file between the
        // recursive listing and the rmdir (ENOTEMPTY on CI). Retry once after
        // the children are gone; a leftover temp dir is not a test failure.
        for (let attempt = 0; attempt < 3; attempt++) {
            try { rmSync(path, { recursive: true, force: true }); return; } catch { /* retry */ }
        }
    };
    t.after(() => {
        for (const child of children) if (child.exitCode === null) child.kill();
        rmQuiet(sharedHome);
        rmQuiet(homeA);
        rmQuiet(homeB);
    });

    const start = (childHome: string, port: string, initialHello: boolean) => {
        const child = spawn(tsx, ['--experimental-test-module-mocks', entry], {
            env: {
                ...process.env,
                HOME: sharedHome,
                CLI_JAW_HOME: childHome,
                SLACK_FIXTURE_PORT: port,
                SLACK_FIXTURE_INITIAL_HELLO: initialHello ? '1' : '0',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.push(child);
        exited.set(child, new Promise<void>(resolve => child.once('exit', () => resolve())));
        let buffered = '';
        let stderrTail = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-2000); });
        const waiters: Array<(value: Record<string, unknown>) => void> = [];
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            buffered += chunk;
            const lines = buffered.split('\n');
            buffered = lines.pop()!;
            for (const line of lines) {
                if (!line.startsWith('FIXTURE ')) continue;
                waiters.shift()?.(JSON.parse(line.slice(8)));
            }
        });
        const next = () => new Promise<Record<string, unknown>>((resolve, reject) => {
            // A cold tsx boot of the whole server graph under module mocks takes
            // several seconds on a loaded CI runner (preview run 34196670148 hit
            // the 10s bound with nothing printed yet). The bound is a hang guard,
            // not a performance assertion, so give CI the headroom it needs and
            // include stderr so a real crash is readable.
            const timer = setTimeout(() => reject(new Error(`fixture timeout: stdout=${JSON.stringify(buffered)} stderr=${JSON.stringify(stderrTail)}`)), process.env['CI'] ? 60_000 : 20_000);
            waiters.push(value => { clearTimeout(timer); resolve(value); });
        });
        return { child, next };
    };

    const a = start(homeA, '4101', false);
    const aReady = await a.next();
    assert.deepEqual(aReady.outcome, { started: true });
    assert.equal(aReady.running, true);

    const b = start(homeB, '4102', true);
    const bReady = await b.next();
    assert.deepEqual(bReady.outcome, { started: true });
    assert.equal(bReady.running, true);
    const bClaimId = bReady.claimId;

    a.child.stdin.write('hello\n');
    const aAfterHello = await a.next();
    b.child.stdin.write('status\n');
    const bStatus = await b.next();
    assert.equal(aAfterHello.stopped, 1);
    assert.equal(aAfterHello.running, false);
    assert.equal(bStatus.running, true);
    assert.equal(bStatus.claimId, bClaimId);

    const claimRoot = join(sharedHome, '.cli-jaw-shared', 'slack-claims');
    const files = readdirSync(claimRoot).filter(file => file.endsWith('.json'));
    assert.equal(files.length, 1);
    const claim = JSON.parse(readFileSync(join(claimRoot, files[0]!), 'utf8'));
    assert.equal(claim.claimId, bClaimId);
    assert.equal(claim.home, realpathSync.native(homeB));

    a.child.stdin.write('shutdown\n');
    b.child.stdin.write('shutdown\n');
    // Both fixtures release their leases and exit on shutdown; wait for the
    // reports and the process exits so cleanup never races a live child.
    await a.next();
    await b.next();
    a.child.stdin.end();
    b.child.stdin.end();
    await Promise.all([exited.get(a.child), exited.get(b.child)]);
});
