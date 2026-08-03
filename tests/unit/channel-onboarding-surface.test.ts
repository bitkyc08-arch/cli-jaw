// Source contract for the onboarding wizard: the popup must exist for all
// three channels, be reachable from each settings section, and be the thing
// an unconfigured channel activation opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

test('every channel section exposes a wizard trigger', () => {
    const html = read('public/index.html');
    for (const ch of ['telegram', 'discord', 'slack']) {
        assert.ok(html.includes(`data-onboard-channel="${ch}"`), `no wizard trigger for ${ch}`);
    }
});

test('the wizard is initialized once from main.ts', () => {
    const main = read('public/js/main.ts');
    assert.match(main, /initChannelOnboarding\(\)/);
    assert.match(main, /from '\.\/features\/channel-onboarding\.js'/);
});

test('activating an unconfigured channel opens the wizard, not the read-only dialog', () => {
    const guide = read('public/js/features/channel-setup-guide.ts');
    assert.match(guide, /openChannelOnboarding\(ch\)/);
    assert.ok(!guide.includes('openHelpDialog('), 'the guard should no longer open the passive help dialog');
});

test('the wizard validates through the server route before saving', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.ok(mod.includes("'/api/channels/validate'"), 'no validation call');
    assert.ok(mod.includes("apiJson('/api/settings', 'PUT'"), 'no settings save');
    // Saving re-checks the verification gate instead of trusting the UI: the
    // save handler asks the flow whether step 3 is still satisfied.
    assert.match(mod, /blockerForStep\(\{ \.\.\.flow, step: 3 \}\)/);
});

test('the wizard renders four gated steps with a visible position', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.match(mod, /\$\{state\.step\}\/\$\{TOTAL_STEPS\}/, 'no 1/4 style step counter');
    assert.ok(mod.includes('data-onboard-next'), 'no next control');
    assert.ok(mod.includes('data-onboard-back'), 'no back control');
    // Advancing goes through the flow gate, never a raw step increment.
    assert.match(mod, /flow = advance\(flow\)/);
    assert.ok(!/state\.step \+ 1/.test(mod), 'the UI must not move steps by itself');
});

test('the step machine is a DOM-free module so its gates are testable', () => {
    const flowMod = read('public/js/features/channel-onboarding-flow.ts');
    assert.ok(!flowMod.includes('document.'), 'the flow module must stay DOM-free');
    assert.ok(!/^import /m.test(flowMod), 'the flow module must stay import-free');
});

test('the popup behaves like a form: autofocus, Enter, Escape', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.match(mod, /focusFirstEmptyField\(\)/, 'no autofocus after render');
    assert.match(mod, /key !== 'Enter'/, 'Enter is not handled in the fields');
    assert.match(mod, /primaryAction\(\)/, 'Enter must trigger the step primary action');
    assert.match(mod, /ev\.key !== 'Escape'/, 'Escape does not close the popup');
    // Escape must be capture-phase like help-dialog, so the two overlays never
    // both react to one key press.
    assert.match(mod, /addEventListener\('keydown',[\s\S]{0,400}?\}, true\)/);
});

test('every credential field shows an example and where it comes from', () => {
    const flowMod = read('public/js/features/channel-onboarding-flow.ts');
    const mod = read('public/js/features/channel-onboarding.ts');
    const ko = JSON.parse(read('public/locales/ko.json')) as Record<string, string>;

    // Placeholders are illustrative shapes, wired from the field definitions.
    assert.match(mod, /placeholder="\$\{escapeHtml\(field\.example\)\}"/);
    for (const example of [...flowMod.matchAll(/example: '([^']+)'/g)].map(m => m[1]!)) {
        assert.ok(example.length > 0);
        assert.ok(!/^[0-9a-f]{32,}$/i.test(example), 'examples must not look like real credentials');
    }
    // Every field has a source hint in ko.
    const channelFields: Record<string, string[]> = {
        telegram: ['botToken'],
        discord: ['botToken', 'guildId'],
        slack: ['botToken', 'appToken'],
    };
    for (const [channel, keys] of Object.entries(channelFields)) {
        for (const key of keys) {
            assert.ok(ko[`onboarding.hint.${channel}.${key}`], `ko.json missing hint for ${channel}.${key}`);
        }
    }
});

test('step 1 offers a real link to the issuing page for every channel', () => {
    const flowMod = read('public/js/features/channel-onboarding-flow.ts');
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.match(flowMod, /ISSUER_URLS/);
    for (const url of ['t.me/BotFather', 'discord.com/developers/applications', 'api.slack.com/apps']) {
        assert.ok(flowMod.includes(url), `missing issuer URL ${url}`);
    }
    assert.match(mod, /data-onboard-issuer/, 'no issuer button in step 1');
});

test('notification permission is requested from the save gesture, once', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    const notif = read('public/js/features/notifications.ts');
    assert.match(mod, /maybeRequestNotificationPermission\(\)/);
    // Never on load: the only call site sits in the save path.
    const saveIdx = mod.indexOf('async function runSave');
    assert.ok(mod.indexOf('maybeRequestNotificationPermission()', saveIdx) > saveIdx);
    assert.match(notif, /localStorage\.setItem/, 'the ask must be remembered');
});

// ─── Robustness sweep regressions (260803) ──────────

test('an in-flight request cannot be applied to a different flow', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    // Switching channels mid-validation must not mark the new flow verified
    // with the old channel's result.
    assert.match(mod, /flowGeneration \+= 1/, 'the generation must bump on open');
    const guards = mod.match(/generation !== flowGeneration/g) ?? [];
    assert.ok(guards.length >= 2, `validate and save must both guard, found ${guards.length}`);
});

test('validate and save are single-flight', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.match(mod, /if \(!flow \|\| validating\) return/, 'double-click Validate must be ignored');
    assert.match(mod, /if \(!flow \|\| saving\) return/, 'double-click Save must be ignored');
    // A throwing save must not wedge the button forever.
    assert.match(mod, /finally \{\s*saving = false;\s*\}/);
});

test('the validate response type carries the missing-scope list', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    // Without this the server's missing_scopes detail is silently dropped.
    assert.match(mod, /missing\?: string\[\]/);
    assert.match(mod, /state\.missingScopes\.length/, 'the list must render');
});

test('the modal is announced and keyboard-contained', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.match(mod, /aria-labelledby="onboarding-title"/, 'dialog needs an accessible name');
    assert.match(mod, /id="onboarding-title"/);
    assert.match(mod, /role="alert"/, 'errors must be announced');
    assert.match(mod, /role="status" aria-live="polite"/, 'step changes must be announced');
    assert.match(mod, /ev\.key !== 'Tab'/, 'no focus trap: Tab escapes the modal');
    assert.match(mod, /onboarding\.progressLabel/, 'the step counter needs a translated label');
});

test('every onboarding i18n key the module uses exists in ko and en', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    const ko = JSON.parse(read('public/locales/ko.json')) as Record<string, string>;
    const en = JSON.parse(read('public/locales/en.json')) as Record<string, string>;
    const literal = [...mod.matchAll(/t\('(onboarding\.[a-zA-Z.]+)'/g)].map(m => m[1]!);
    // Only single-variable templates like `onboarding.guide.${channel}` join a
    // prefix to a channel. Two-variable keys (hint.${channel}.${field}) are
    // covered by the per-field hint test instead — matching them here would
    // capture a truncated prefix and assert keys that never existed.
    const templated = [...mod.matchAll(/t\(`(onboarding\.[a-zA-Z.]+)\.\$\{[a-zA-Z.]+\}`/g)].map(m => m[1]!);
    for (const key of new Set(literal)) {
        assert.ok(ko[key], `ko.json missing ${key}`);
        assert.ok(en[key], `en.json missing ${key}`);
    }
    // Every step label must exist, or the header renders a raw key.
    for (let step = 1; step <= 4; step++) {
        assert.ok(ko[`onboarding.step.${step}`], `ko.json missing onboarding.step.${step}`);
        assert.ok(en[`onboarding.step.${step}`], `en.json missing onboarding.step.${step}`);
    }
    // Templated families (title/guide/next/token/error) must cover every channel.
    for (const prefix of new Set(templated)) {
        for (const ch of ['telegram', 'discord', 'slack']) {
            if (prefix === 'onboarding.token' || prefix === 'onboarding.error' || prefix === 'onboarding.step') continue;
            assert.ok(ko[`${prefix}.${ch}`], `ko.json missing ${prefix}.${ch}`);
            assert.ok(en[`${prefix}.${ch}`], `en.json missing ${prefix}.${ch}`);
        }
    }
});

test('every validate-route error code has a user-facing message', () => {
    const route = read('src/messaging/channel-validate.ts');
    const flow = read('public/js/features/channel-onboarding-flow.ts');
    const ko = JSON.parse(read('public/locales/ko.json')) as Record<string, string>;
    const codes = [
        ...[...route.matchAll(/error: '([a-z_]+)'/g)].map(m => m[1]!),
        // The flow's own offline blockers use the same message namespace.
        ...[...flow.matchAll(/return '([a-z_]+)'/g)].map(m => m[1]!),
    ];
    assert.ok(codes.length >= 6, `expected the error vocabulary, found ${codes.length}`);
    for (const code of new Set(codes)) {
        assert.ok(ko[`onboarding.error.${code}`], `no message for error code ${code}`);
    }
});
