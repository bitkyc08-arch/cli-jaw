import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><body>
    <input id="slBotToken" value="">
    <input id="slAppToken" value="">
    <input id="slTeamId" value="">
    <input id="slChannelIds" value="">
    <input id="slAttachPort" value="">
    <button id="slack-reset-connection"></button>
    <button id="slack-onboarding-trigger"></button>
    <button id="slOff"></button>
    <button id="slOn" class="active"></button>
    <div id="slack-environment-managed" style="display:none"></div>
    <div id="slack-bot-token-error"></div>
    <div id="slack-app-token-error"></div>
</body>`, { url: 'http://127.0.0.1:3459/' });

Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });

type FetchCall = { url: string; method: string; body: unknown };
let fetchCalls: FetchCall[] = [];
let settingsRequestSucceeds = true;
let resetResponseLost = false;
let managedEnvironmentVariables: string[] = [];
let authoritativeSlack: Record<string, unknown> = {};
let confirmResult = false;
let confirmCalls = 0;
let alerts: string[] = [];

Object.defineProperty(dom.window, 'confirm', {
    configurable: true,
    value: () => {
        confirmCalls += 1;
        return confirmResult;
    },
});
Object.defineProperty(dom.window, 'alert', {
    configurable: true,
    value: (message: string) => alerts.push(message),
});

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/api/auth/token')) {
        return new Response(JSON.stringify({ token: '' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }
    fetchCalls.push({
        url,
        method: init?.method || 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith('/api/settings/slack/reset')) {
        if (managedEnvironmentVariables.length > 0) {
            return new Response(JSON.stringify({
                ok: false,
                error: 'slack_connection_managed_by_environment',
                environmentVariables: managedEnvironmentVariables,
            }), {
                status: 409,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (settingsRequestSucceeds) {
            authoritativeSlack = {
                enabled: false,
                botToken: '',
                appToken: '',
                teamId: '',
                channelIds: [],
                attachPort: '',
            };
            if (resetResponseLost) throw new Error('response lost after commit');
        }
        return new Response(JSON.stringify(settingsRequestSucceeds
            ? { ok: true, data: { slack: authoritativeSlack } }
            : { ok: false, error: 'reset_failed' }), {
            status: settingsRequestSucceeds ? 200 : 500,
            headers: { 'content-type': 'application/json' },
        });
    }
    return new Response(JSON.stringify({
        ok: true,
        data: { slack: authoritativeSlack, slackEnvironmentVariables: managedEnvironmentVariables },
    }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
};

const { loadSlackSettings, resetSlackConnection } = await import('../../public/js/features/settings-slack.ts');

function input(id: string): HTMLInputElement {
    return document.getElementById(id) as HTMLInputElement;
}

beforeEach(() => {
    fetchCalls = [];
    settingsRequestSucceeds = true;
    resetResponseLost = false;
    managedEnvironmentVariables = [];
    authoritativeSlack = {};
    confirmResult = false;
    confirmCalls = 0;
    alerts = [];
    for (const id of ['slBotToken', 'slAppToken', 'slTeamId', 'slChannelIds', 'slAttachPort']) {
        input(id).value = '';
        input(id).className = '';
        input(id).disabled = false;
    }
    for (const id of ['slack-reset-connection', 'slack-onboarding-trigger', 'slOff', 'slOn']) {
        (document.getElementById(id) as HTMLButtonElement).disabled = false;
    }
    loadSlackSettings({
        cli: 'codex', workingDir: '', permissions: 'auto',
        slack: { enabled: true },
        slackEnvironmentVariables: [],
    });
    document.getElementById('slOn')?.classList.add('active');
    document.getElementById('slOff')?.classList.remove('active');
    for (const id of ['slack-bot-token-error', 'slack-app-token-error']) {
        const error = document.getElementById(id);
        if (error) error.style.display = '';
    }
});

test('reset reports an empty connection without confirming or writing settings', async () => {
    await resetSlackConnection();

    assert.deepEqual(alerts, ['settings.slack.resetEmpty']);
    assert.equal(confirmCalls, 0);
    assert.equal(fetchCalls.length, 0);
});

test('reset cancellation preserves credentials and does not write settings', async () => {
    input('slBotToken').value = 'xoxb-test-token';

    await resetSlackConnection();

    assert.equal(confirmCalls, 1);
    assert.equal(input('slBotToken').value, 'xoxb-test-token');
    assert.equal(fetchCalls.length, 0);
});

test('confirmed reset clears fields after the reset API and authoritative read-back agree', async () => {
    input('slBotToken').value = 'xoxb-test-token';
    input('slAppToken').value = 'xapp-test-token';
    input('slTeamId').value = 'T-TEST';
    input('slChannelIds').value = 'C-TEST';
    input('slAttachPort').value = '3459';
    input('slBotToken').classList.add('input-error');
    confirmResult = true;

    await resetSlackConnection();

    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(fetchCalls[0], {
        url: '/api/settings/slack/reset',
        method: 'POST',
        body: undefined,
    });
    assert.deepEqual(fetchCalls[1], { url: '/api/settings', method: 'GET', body: undefined });
    for (const id of ['slBotToken', 'slAppToken', 'slTeamId', 'slChannelIds', 'slAttachPort']) {
        assert.equal(input(id).value, '', `${id} was not cleared`);
        assert.equal(input(id).classList.contains('input-error'), false);
    }
    assert.equal(document.getElementById('slOff')?.classList.contains('active'), true);
    assert.equal(document.getElementById('slOn')?.classList.contains('active'), false);
    assert.deepEqual(alerts, []);
});

test('failed reset keeps current credentials and reports the failure', async () => {
    input('slBotToken').value = 'xoxb-test-token';
    authoritativeSlack = { enabled: true, botToken: 'xoxb-test-token' };
    confirmResult = true;
    settingsRequestSucceeds = false;

    await resetSlackConnection();

    assert.equal(input('slBotToken').value, 'xoxb-test-token');
    assert.deepEqual(alerts, ['settings.slack.resetFailed']);
});

test('environment-managed reset names the variables and locks redacted fields', async () => {
    input('slBotToken').value = 'xoxb-env-token';
    input('slAppToken').value = 'xapp-ui-token';
    authoritativeSlack = { enabled: true, botToken: '', appToken: '' };
    managedEnvironmentVariables = ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_IDS'];
    confirmResult = true;

    await resetSlackConnection();

    assert.equal(input('slBotToken').value, '');
    assert.equal(input('slAppToken').value, '');
    assert.equal(input('slBotToken').disabled, true);
    assert.equal((document.getElementById('slOn') as HTMLButtonElement).disabled, true);
    assert.equal((document.getElementById('slack-onboarding-trigger') as HTMLButtonElement).disabled, true);
    assert.equal(document.getElementById('slack-environment-managed')?.style.display, '');
    assert.deepEqual(alerts, ['settings.slack.resetManagedByEnvironment']);
    assert.deepEqual(fetchCalls.map(({ url, method }) => ({ url, method })), [
        { url: '/api/settings/slack/reset', method: 'POST' },
        { url: '/api/settings', method: 'GET' },
    ]);
});

test('authoritative environment metadata proactively locks connection controls', () => {
    loadSlackSettings({
        cli: 'codex', workingDir: '', permissions: 'auto',
        slack: { enabled: true, botToken: '', appToken: '', forwardAll: true },
        slackEnvironmentVariables: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
    });

    for (const id of ['slBotToken', 'slAppToken', 'slTeamId', 'slChannelIds', 'slAttachPort']) {
        assert.equal(input(id).disabled, true, `${id} should be read-only`);
    }
    for (const id of ['slOff', 'slOn', 'slack-reset-connection', 'slack-onboarding-trigger']) {
        assert.equal((document.getElementById(id) as HTMLButtonElement).disabled, true, `${id} should be disabled`);
    }
    assert.equal(
        document.getElementById('slack-environment-managed')?.textContent,
        'settings.slack.managedByEnvironment',
    );
});

test('lost reset response is recovered by authoritative settings read-back', async () => {
    input('slBotToken').value = 'xoxb-test-token';
    authoritativeSlack = { enabled: true, botToken: 'xoxb-test-token' };
    resetResponseLost = true;
    confirmResult = true;

    await resetSlackConnection();

    assert.equal(input('slBotToken').value, '');
    assert.deepEqual(alerts, []);
});
