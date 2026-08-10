// The 1/4 → 4/4 wizard contract: every step is gated by its own rule, drafts
// survive movement in both directions, and a credential edit invalidates a
// previous validation so a stale pass can never reach save.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TOTAL_STEPS,
    advance,
    applyValidation,
    blockerForStep,
    canAdvance,
    createFlow,
    goBack,
    markSlackIssuerOpened,
    markSlackManifestGenerated,
    markSaved,
    resetSlackSetup,
    setField,
    settingsPatch,
    validationPayload,
    type FlowState,
} from '../../public/js/features/channel-onboarding-flow.ts';

function atCredentials(channel: 'telegram' | 'discord' | 'slack', draft: Record<string, string>): FlowState {
    return { ...createFlow(channel, draft), step: 2 };
}

test('the flow is four steps and starts at the guide', () => {
    assert.equal(TOTAL_STEPS, 4);
    const flow = createFlow('telegram');
    assert.equal(flow.step, 1);
    assert.equal(blockerForStep(flow), null, 'the guide step never blocks');
});

test('Slack guide unlocks in manifest then issuer order and resets after an app-name edit', () => {
    let flow = createFlow('slack');
    assert.equal(flow.slackSetupStage, 'manifest');
    assert.equal(canAdvance(flow), false);
    assert.equal(advance(flow).error, 'slack_setup_required');

    flow = markSlackManifestGenerated(flow);
    assert.equal(flow.slackSetupStage, 'issuer');
    assert.equal(canAdvance(flow), false);

    flow = markSlackIssuerOpened(flow);
    assert.equal(flow.slackSetupStage, 'ready');
    assert.equal(canAdvance(flow), true);
    assert.equal(advance(flow).step, 2);

    flow = resetSlackSetup(flow);
    assert.equal(flow.slackSetupStage, 'manifest');
    assert.equal(canAdvance({ ...flow, step: 1 }), false);
});

test('step 2 refuses to advance without the required credential', () => {
    const empty = atCredentials('telegram', {});
    assert.equal(canAdvance(empty), false);
    const blocked = advance(empty);
    assert.equal(blocked.step, 2, 'a blocked step does not move');
    assert.equal(blocked.error, 'token_required');

    const filled = setField(empty, 'botToken', '123:ABC');
    assert.equal(canAdvance(filled), true);
    assert.equal(advance(filled).step, 3);
});

test('discord needs both the token and the server id', () => {
    const tokenOnly = atCredentials('discord', { botToken: 'MTI' });
    assert.equal(advance(tokenOnly).error, 'guild_required');
    const both = setField(tokenOnly, 'guildId', '123');
    assert.equal(advance(both).step, 3);
});

test('slack catches swapped tokens before any network call', () => {
    const swapped = atCredentials('slack', { botToken: 'xapp-1', appToken: 'xoxb-1' });
    assert.equal(advance(swapped).error, 'bot_prefix');

    const badApp = atCredentials('slack', { botToken: 'xoxb-1', appToken: 'xoxp-1' });
    assert.equal(advance(badApp).error, 'app_prefix');

    // The app token is optional: absent is fine (outbound-only).
    const outboundOnly = atCredentials('slack', { botToken: 'xoxb-1' });
    assert.equal(advance(outboundOnly).step, 3);
});

test('step 3 blocks until validation actually passes', () => {
    let flow: FlowState = { ...atCredentials('telegram', { botToken: '123:ABC' }), step: 3 };
    assert.equal(blockerForStep(flow), 'validation_required');
    assert.equal(advance(flow).step, 3, 'no skipping the verification gate');

    flow = applyValidation(flow, { ok: false, error: 'invalid_token' });
    assert.equal(flow.error, 'invalid_token');
    assert.equal(advance(flow).step, 3);

    flow = applyValidation(flow, { ok: true, identity: '@jawbot' });
    assert.equal(flow.validatedIdentity, '@jawbot');
    assert.equal(advance(flow).step, 4);
});

test('missing files:read remains visible but does not block step 3', () => {
    let flow: FlowState = {
        ...atCredentials('slack', { botToken: 'xoxb-1' }),
        step: 3,
    };
    flow = applyValidation(flow, {
        ok: true,
        identity: 'cli-jaw',
        missingCapabilities: ['files:read'],
    });
    assert.deepEqual(flow.missingCapabilities, ['files:read']);
    assert.equal(blockerForStep(flow), null);
    assert.equal(advance(flow).step, 4);
    flow = setField(flow, 'botToken', 'xoxb-2');
    assert.deepEqual(flow.missingCapabilities, []);
});

test('drafts survive moving back and forward', () => {
    let flow = setField(atCredentials('slack', {}), 'botToken', 'xoxb-typed');
    flow = advance(flow);
    assert.equal(flow.step, 3);
    flow = goBack(flow);
    assert.equal(flow.step, 2);
    assert.equal(flow.draft['botToken'], 'xoxb-typed', 'the pasted value must not be lost');
    flow = goBack(flow);
    assert.equal(flow.step, 1);
    assert.equal(flow.draft['botToken'], 'xoxb-typed');
});

test('editing a credential invalidates an earlier validation', () => {
    let flow: FlowState = { ...atCredentials('telegram', { botToken: 'good' }), step: 3 };
    flow = applyValidation(flow, { ok: true, identity: '@jawbot' });
    assert.equal(flow.validatedIdentity, '@jawbot');

    flow = setField(flow, 'botToken', 'changed-after-validation');
    assert.equal(flow.validatedIdentity, null, 'a stale pass must not carry over');
    assert.equal(blockerForStep({ ...flow, step: 3 }), 'validation_required');
});

test('the validation payload and settings patch are built from the draft', () => {
    let flow: FlowState = { ...atCredentials('slack', { botToken: 'xoxb-1', appToken: 'xapp-1' }), step: 3 };
    assert.deepEqual(validationPayload(flow), { channel: 'slack', botToken: 'xoxb-1', appToken: 'xapp-1' });

    flow = applyValidation(flow, { ok: true, identity: 'cli-jaw', teamId: 'T1' });
    assert.deepEqual(settingsPatch(flow), {
        slack: { enabled: true, botToken: 'xoxb-1', appToken: 'xapp-1', teamId: 'T1' },
    });

    const tg = applyValidation({ ...atCredentials('telegram', { botToken: '123:ABC' }), step: 3 }, { ok: true, identity: '@b' });
    assert.deepEqual(settingsPatch(tg), { telegram: { enabled: true, token: '123:ABC' } });

    const dc = applyValidation({ ...atCredentials('discord', { botToken: 'MTI', guildId: '9' }), step: 3 }, { ok: true, identity: 'b' });
    assert.deepEqual(settingsPatch(dc), { discord: { enabled: true, token: 'MTI', guildId: '9' } });
});

test('the final step closes the flow', () => {
    const saved = markSaved({ ...atCredentials('telegram', { botToken: '1' }), step: 4 });
    assert.equal(saved.saved, true);
    assert.equal(saved.step, TOTAL_STEPS);
    assert.equal(advance(saved).step, TOTAL_STEPS, 'there is nothing past the last step');
    assert.equal(goBack(createFlow('slack')).step, 1, 'there is nothing before the first step');
});
