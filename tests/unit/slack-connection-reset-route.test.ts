import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Express } from 'express';

const home = process.env['CLI_JAW_HOME'];
assert.ok(home, 'tests/setup/test-home.ts must provide CLI_JAW_HOME');

const slackEnvironmentVariables = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_TEAM_ID',
    'SLACK_CHANNEL_IDS',
] as const;
for (const key of slackEnvironmentVariables) delete process.env[key];

const auditEntries: Array<Record<string, unknown>> = [];

mock.module('../../src/security/security-audit-log.ts', {
    namedExports: {
        getSecurityAuditLog: () => ({
            append: (_event: string, _actor: string, detail: Record<string, unknown>) => {
                auditEntries.push(detail);
            },
        }),
    },
});

const { registerSettingsRoutes } = await import('../../src/routes/settings.ts');
const config = await import('../../src/core/config.ts');
const runtimeSettings = await import('../../src/core/runtime-settings.ts');

afterEach(() => {
    for (const key of slackEnvironmentVariables) delete process.env[key];
    config.loadSettings();
});

type RouteHandler = (req: any, res: any, next: (error?: unknown) => void) => void;

const allowAuth: RouteHandler = (_req, _res, next): void => next();
const denyAuth: RouteHandler = (_req, res): void => {
    res.status(401).json({ ok: false, error: 'unauthorized' });
};

function registerRouteApp(
    auth: RouteHandler,
    applySettings: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>,
    method: 'GET' | 'PUT' | 'POST' = 'POST',
    path = '/api/settings/slack/reset',
) {
    const routes = new Map<string, RouteHandler[]>();
    const register = (verb: string) => (routePath: string, ...handlers: RouteHandler[]): void => {
        routes.set(`${verb} ${routePath}`, handlers);
    };
    const app = { get: register('GET'), put: register('PUT'), post: register('POST') } as unknown as Express;
    registerSettingsRoutes(app, auth as never, applySettings, process.cwd());
    const route = routes.get(`${method} ${path}`);
    assert.ok(route, `${method} ${path} was not registered`);
    return route;
}

async function routeRequest(handlers: RouteHandler[], body: Record<string, unknown> = {}) {
    return await new Promise<{ status: number; json: Record<string, any> }>((resolve, reject) => {
        let status = 200;
        const response = {
            status(code: number) { status = code; return response; },
            json(body: Record<string, any>) { resolve({ status, json: body }); },
        };
        const request = { body, ip: 'local', query: {}, params: {} };
        const run = (index: number): void => {
            const handler = handlers[index];
            if (!handler) return reject(new Error('route completed without a response'));
            handler(request, response, (error?: unknown) => {
                if (error) reject(error);
                else run(index + 1);
            });
        };
        run(0);
    });
}

test('Slack reset route is authenticated', async () => {
    let applies = 0;
    const route = registerRouteApp(denyAuth, async () => { applies += 1; return {}; });
    const result = await routeRequest(route);
    assert.equal(result.status, 401);
    assert.equal(applies, 0);
});

test('Slack reset route clears every persisted connection field', async () => {
    const patches: Record<string, unknown>[] = [];
    const route = registerRouteApp(allowAuth, async (patch) => {
        patches.push(patch);
        return patch;
    });
    const { status, json } = await routeRequest(route);
    assert.equal(status, 200);
    assert.deepEqual(patches, [{
        slack: {
            enabled: false,
            botToken: '',
            appToken: '',
            teamId: '',
            channelIds: [],
            attachPort: '',
        },
    }]);
    assert.equal(json.ok, true);
    assert.equal(json.data.slack.enabled, false);
});

test('Slack reset route rejects mixed environment-managed settings without exposing values', async () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-secret-value';
    process.env['SLACK_CHANNEL_IDS'] = 'C-SECRET';
    let applies = 0;
    const route = registerRouteApp(allowAuth, async () => { applies += 1; return {}; });
    const { status, json } = await routeRequest(route);
    assert.equal(status, 409);
    assert.equal(json.error, 'slack_connection_managed_by_environment');
    assert.deepEqual(json.environmentVariables, ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_IDS']);
    assert.equal(JSON.stringify(json).includes('xoxb-secret-value'), false);
    assert.equal(JSON.stringify(json).includes('C-SECRET'), false);
    assert.equal(applies, 0);
});

test('refused environment-managed reset remains explicit after settings reload', async () => {
    config.saveSettings({
        ...config.settings,
        slack: {
            ...config.settings['slack'],
            enabled: true,
            botToken: 'xoxb-persisted-token',
            appToken: 'xapp-persisted-token',
        },
    });
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-environment-token';
    const before = config.loadSettings() as Record<string, any>;
    assert.equal(before.slack.botToken, 'xoxb-environment-token');

    let applies = 0;
    const route = registerRouteApp(allowAuth, async () => { applies += 1; return {}; });
    const { status, json } = await routeRequest(route);
    assert.equal(status, 409);
    assert.deepEqual(json.environmentVariables, ['SLACK_BOT_TOKEN']);
    assert.equal(applies, 0);

    const reloaded = config.loadSettings() as Record<string, any>;
    assert.equal(reloaded.slack.enabled, true);
    assert.equal(reloaded.slack.botToken, 'xoxb-environment-token');
    config.saveSettings({ ...reloaded, locale: 'en' });
    const persisted = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, any>;
    assert.equal('enabled' in persisted.slack, false);
    assert.equal('botToken' in persisted.slack, false);
    assert.equal(persisted.slack.appToken, 'xapp-persisted-token');
    assert.equal(persisted.slack.teamId, '');
    assert.deepEqual(persisted.slack.channelIds, []);
    assert.equal(persisted.slack.attachPort || '', '');
    assert.equal(JSON.stringify(persisted).includes('xoxb-environment-token'), false);
});

test('settings API rejects environment-managed connection writes but allows behavior settings', async () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-secret-value';
    const patches: Record<string, unknown>[] = [];
    const put = registerRouteApp(
        allowAuth,
        async (patch) => { patches.push(patch); return patch; },
        'PUT',
        '/api/settings',
    );

    const rejected = await routeRequest(put, { slack: { botToken: 'xoxb-ui-token', enabled: false } });
    assert.equal(rejected.status, 409);
    assert.deepEqual(rejected.json.managedPaths, ['slack.enabled', 'slack.botToken']);
    assert.equal(JSON.stringify(rejected.json).includes('xoxb-secret-value'), false);
    assert.equal(patches.length, 0);

    const allowed = await routeRequest(put, { slack: { forwardAll: false, mentionOnly: true } });
    assert.equal(allowed.status, 200);
    assert.deepEqual(patches, [{ slack: { forwardAll: false, mentionOnly: true } }]);
});

test('settings GET reports environment provenance without returning Slack values', async () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-secret-value';
    process.env['SLACK_TEAM_ID'] = 'T-SECRET';
    config.loadSettings();
    const get = registerRouteApp(allowAuth, async () => ({}), 'GET', '/api/settings');
    const { status, json } = await routeRequest(get);

    assert.equal(status, 200);
    assert.deepEqual(json.data.slackEnvironmentVariables, ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID']);
    assert.equal(json.data.slack.enabled, true);
    assert.equal(json.data.slack.botToken, '');
    assert.equal(json.data.slack.teamId, '');
    assert.equal(JSON.stringify(json).includes('xoxb-secret-value'), false);
    assert.equal(JSON.stringify(json).includes('T-SECRET'), false);
});

test('shared runtime settings boundary rejects environment-managed Slack connection writes', async () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-secret-value';
    await assert.rejects(
        runtimeSettings.applyRuntimeSettingsPatch({ slack: { enabled: false } }),
        /slack_connection_managed_by_environment/,
    );
});

test('metadata-only Slack environment overrides preserve file-backed credentials', () => {
    config.saveSettings({
        ...config.settings,
        slack: {
            ...config.settings['slack'],
            enabled: true,
            botToken: 'xoxb-file-token',
            appToken: 'xapp-file-token',
            teamId: 'T-FILE',
            channelIds: ['C-FILE'],
            attachPort: '3999',
        },
    });
    process.env['SLACK_TEAM_ID'] = 'T-ENV';
    process.env['SLACK_CHANNEL_IDS'] = 'C-ENV';

    const reloaded = config.loadSettings() as Record<string, any>;
    assert.equal(reloaded.slack.enabled, true);
    assert.equal(reloaded.slack.botToken, 'xoxb-file-token');
    assert.equal(reloaded.slack.appToken, 'xapp-file-token');
    assert.equal(reloaded.slack.teamId, 'T-ENV');
    assert.deepEqual(reloaded.slack.channelIds, ['C-ENV']);
    assert.equal(reloaded.slack.attachPort, '3999');

    const persisted = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, any>;
    assert.equal(persisted.slack.botToken, 'xoxb-file-token');
    assert.equal(persisted.slack.appToken, 'xapp-file-token');
    assert.equal(persisted.slack.attachPort, '3999');
    assert.equal('teamId' in persisted.slack, false);
    assert.equal('channelIds' in persisted.slack, false);
    assert.equal(JSON.stringify(persisted).includes('T-ENV'), false);
    assert.equal(JSON.stringify(persisted).includes('C-ENV'), false);
});

test('generic settings writes reject only fields owned by configured Slack environment variables', async () => {
    process.env['SLACK_TEAM_ID'] = 'T-ENV';
    const patches: Record<string, unknown>[] = [];
    const put = registerRouteApp(
        allowAuth,
        async (patch) => { patches.push(patch); return patch; },
        'PUT',
        '/api/settings',
    );

    const unrelated = await routeRequest(put, {
        slack: { enabled: true, botToken: 'xoxb-file-token', appToken: 'xapp-file-token', attachPort: '3999' },
    });
    assert.equal(unrelated.status, 200);
    assert.equal(patches.length, 1);

    const owned = await routeRequest(put, { slack: { teamId: 'T-FILE' } });
    assert.equal(owned.status, 409);
    assert.deepEqual(owned.json.environmentVariables, ['SLACK_TEAM_ID']);
    assert.deepEqual(owned.json.managedPaths, ['slack.teamId']);
    assert.equal(patches.length, 1);
});

// The allowlist is the inbound surface: empty allows every conversation,
// non-empty allows exactly those. An agent narrowed it to one channel and cut
// itself off, and nothing recorded that it had happened (#406). Blocking the
// write is not an option — `jaw slack setup --channel-ids` reaches the server
// through this same PUT — so the classification is what the audit entry rides on.
test('classifyAllowlistChange names the direction of a channelIds write', async () => {
    const { classifyAllowlistChange } = await import('../../src/routes/settings.js');

    // [] means "every conversation", so going to a list is a narrowing.
    assert.deepEqual(classifyAllowlistChange(['A'], []), { kind: 'narrow', from: [], to: ['A'] });
    assert.deepEqual(
        classifyAllowlistChange(['A'], ['A', 'B']),
        { kind: 'narrow', from: ['A', 'B'], to: ['A'] },
    );

    assert.equal(classifyAllowlistChange(['A', 'B'], ['A'])?.kind, 'widen');
    assert.equal(classifyAllowlistChange([], ['A'])?.kind, 'clear');

    // Nothing moved, and a non-array write is not a channelIds write at all.
    assert.equal(classifyAllowlistChange(['A'], ['A']), null);
    assert.equal(classifyAllowlistChange([], []), null);
    assert.equal(classifyAllowlistChange(undefined, ['A']), null);
});


// A non-array channelIds is not a no-op: the gate reads it as "no allowlist",
// which means EVERY conversation. Letting it through would silently widen an
// existing allowlist to everything while classifyAllowlistChange saw no change
// at all — failing open on a malformed value (#406).
test('invalidSlackChannelIds rejects anything that is not a list of ids', async () => {
    const { invalidSlackChannelIds } = await import('../../src/routes/settings.js');

    assert.equal(invalidSlackChannelIds(undefined), false, 'absent is not a write');
    assert.equal(invalidSlackChannelIds([]), false, 'empty means every conversation');
    assert.equal(invalidSlackChannelIds(['C1', 'C2']), false);

    assert.equal(invalidSlackChannelIds('C1'), true, 'a bare string would read as no allowlist');
    assert.equal(invalidSlackChannelIds([1, 2]), true);
    assert.equal(invalidSlackChannelIds(['C1', '']), true);
    assert.equal(invalidSlackChannelIds(['C1', '   ']), true);
    assert.equal(invalidSlackChannelIds({ 0: 'C1' }), true);
});

test('a malformed channelIds write is refused instead of applied', async () => {
    const patches: Record<string, unknown>[] = [];
    const put = registerRouteApp(
        allowAuth,
        async (patch) => { patches.push(patch); return patch; },
        'PUT',
        '/api/settings',
    );

    const bad = await routeRequest(put, { slack: { channelIds: 'C1' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_slack_channel_ids');
    assert.equal(patches.length, 0, 'a malformed allowlist must not reach applySettings');

    // jaw slack setup --channel-ids reaches the server through this same PUT,
    // so a well-formed narrowing write must still succeed.
    const good = await routeRequest(put, { slack: { channelIds: ['C1'] } });
    assert.equal(good.status, 200);
    assert.equal(patches.length, 1);
});

// Narrowing the allowlist is recorded rather than refused, because jaw slack
// setup --channel-ids reaches the server through this same PUT. The record is
// the whole point: nobody could tell what had happened (#406).
test('a narrowing write succeeds and leaves an audit entry naming both lists', async () => {
    auditEntries.length = 0;
    const patches: Record<string, unknown>[] = [];
    const put = registerRouteApp(
        allowAuth,
        async (patch) => { patches.push(patch); return patch; },
        'PUT',
        '/api/settings',
    );

    const res = await routeRequest(put, { slack: { channelIds: ['C1'] } });
    assert.equal(res.status, 200);
    assert.equal(patches.length, 1);

    const narrow = auditEntries.find(d => d['action'] === 'narrow');
    assert.ok(narrow, 'a narrowing write must leave an audit entry');
    assert.deepEqual(narrow['keys'], ['slack.channelIds']);
    assert.deepEqual(narrow['to'], ['C1']);
    assert.ok(Array.isArray(narrow['from']), 'the entry must carry the previous list');
});
