import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Pure rules mirror doctor's hard failures: telegram=token,
// discord=token+guildId, slack=botToken (appToken missing = outbound-only,
// a WARN — never a popup).

const { isTelegramConfigured, isDiscordConfigured, isSlackConfigured } =
    await import('../../public/js/features/channel-setup-rules.ts');
const { hasSlackBotTokenPrefix, hasSlackAppTokenPrefix } =
    await import('../../public/js/features/channel-setup-rules.ts');

test('slack token prefix helpers catch swapped pastes', () => {
    assert.equal(hasSlackBotTokenPrefix('xoxb-1-abc'), true);
    assert.equal(hasSlackBotTokenPrefix('xapp-1-abc'), false);
    assert.equal(hasSlackBotTokenPrefix(''), false);
    assert.equal(hasSlackAppTokenPrefix('xapp-1-abc'), true);
    assert.equal(hasSlackAppTokenPrefix('xoxb-1-abc'), false);
    assert.equal(hasSlackAppTokenPrefix('  xapp-1-abc  '), true);
});

test('telegram is configured iff a token exists', () => {
    assert.equal(isTelegramConfigured(''), false);
    assert.equal(isTelegramConfigured('   '), false);
    assert.equal(isTelegramConfigured('123:abc'), true);
});

test('discord needs both token and guildId', () => {
    assert.equal(isDiscordConfigured('', ''), false);
    assert.equal(isDiscordConfigured('MTI', ''), false);
    assert.equal(isDiscordConfigured('', '123'), false);
    assert.equal(isDiscordConfigured('MTI', '123'), true);
});

test('slack needs only the bot token — missing appToken is outbound-only, not a popup', () => {
    assert.equal(isSlackConfigured(''), false);
    assert.equal(isSlackConfigured('xoxb-1'), true);
});

// Popup behavior: stub the DOM inputs and capture openHelpDialog calls.

const opened: string[] = [];
mock.module('../../public/js/features/help-dialog.ts', {
    namedExports: {
        openHelpDialog: (topic: string) => { opened.push(topic); },
        closeHelpDialog: () => { },
        isHelpDialogOpen: () => false,
        initHelpDialog: () => { },
    },
});

const inputs: Record<string, string> = {};
(globalThis as Record<string, unknown>)['document'] = {
    getElementById: (id: string) => (id in inputs ? { value: inputs[id] } : null),
};

const { openSetupGuideIfUnconfigured } = await import('../../public/js/features/channel-setup-guide.ts');

function reset(state: Record<string, string>): void {
    opened.length = 0;
    for (const k of Object.keys(inputs)) delete inputs[k];
    Object.assign(inputs, state);
}

test('slack: popup fires when the bot token input is empty', () => {
    reset({ slBotToken: '' });
    openSetupGuideIfUnconfigured('slack');
    assert.deepEqual(opened, ['slack']);
});

test('slack: no popup once a bot token is present (app token irrelevant)', () => {
    reset({ slBotToken: 'xoxb-1', slAppToken: '' });
    openSetupGuideIfUnconfigured('slack');
    assert.deepEqual(opened, []);
});

test('telegram: popup fires without a token, silent with one', () => {
    reset({ tgToken: '' });
    openSetupGuideIfUnconfigured('telegram');
    assert.deepEqual(opened, ['telegram']);
    reset({ tgToken: '123:abc' });
    openSetupGuideIfUnconfigured('telegram');
    assert.deepEqual(opened, []);
});

test('discord: popup fires with token but no guildId', () => {
    reset({ dcToken: 'MTI', dcGuildId: '' });
    openSetupGuideIfUnconfigured('discord');
    assert.deepEqual(opened, ['discord']);
});

test('missing input elements count as empty (fresh settings page)', () => {
    reset({});
    openSetupGuideIfUnconfigured('slack');
    openSetupGuideIfUnconfigured('telegram');
    openSetupGuideIfUnconfigured('discord');
    assert.deepEqual(opened, ['slack', 'telegram', 'discord']);
});
