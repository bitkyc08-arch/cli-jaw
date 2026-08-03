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

test('every onboarding i18n key the module uses exists in ko and en', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    const ko = JSON.parse(read('public/locales/ko.json')) as Record<string, string>;
    const en = JSON.parse(read('public/locales/en.json')) as Record<string, string>;
    const literal = [...mod.matchAll(/t\('(onboarding\.[a-zA-Z.]+)'/g)].map(m => m[1]!);
    const templated = [...mod.matchAll(/t\(`(onboarding\.[a-zA-Z.]+)\.\$\{/g)].map(m => m[1]!);
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
