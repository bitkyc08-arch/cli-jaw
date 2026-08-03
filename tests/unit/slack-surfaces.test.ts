import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

// ─── DOM wiring ─────────────────────────────────────

test('every element id settings-slack.ts reads exists in index.html', () => {
    // The audit caught a settings module whose markup was never added, making
    // the whole surface dead code. This check is mechanical so it cannot rot.
    const module = read('public/js/features/settings-slack.ts');
    const html = read('public/index.html');
    const ids = [...module.matchAll(/getElementById\('(sl[A-Za-z]+)'\)/g)].map(m => m[1]!);
    assert.ok(ids.length >= 12, `expected the module to drive many ids, found ${ids.length}`);
    for (const id of new Set(ids)) {
        assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
    }
});

test('every sl* id in index.html has a listener in main.ts', () => {
    const html = read('public/index.html');
    const main = read('public/js/main.ts');
    const slackBlock = html.slice(html.indexOf('id="channelSlackSettings"'));
    const ids = [...slackBlock.matchAll(/id="(sl[A-Za-z]+)"/g)].map(m => m[1]!);
    for (const id of new Set(ids)) {
        assert.ok(main.includes(`getElementById('${id}')`), `main.ts never wires #${id}`);
    }
});

test('the channel switcher exposes a slack button wired to setActiveChannel', () => {
    assert.ok(read('public/index.html').includes('id="chSlack"'), 'no Slack switcher button');
    assert.match(read('public/js/main.ts'), /getElementById\('chSlack'\)[\s\S]{0,80}setActiveChannel\('slack'\)/);
});

test('slack settings load on page load', () => {
    // Without this the saved settings never populate the form.
    const core = read('public/js/features/settings-core.ts');
    assert.match(core, /import \{ loadSlackSettings \}/);
    assert.match(core, /loadSlackSettings\(s\)/);
});

test('slack setters are re-exported from the settings barrel', () => {
    const barrel = read('public/js/features/settings.ts');
    for (const name of ['setSlack', 'setSlackForwardAll', 'setSlackAllowBots', 'setSlackMentionOnly', 'setSlackReplyInThread', 'saveSlackSettings']) {
        assert.ok(barrel.includes(name), `settings.ts does not re-export ${name}`);
    }
});

test('both slack token inputs are password fields', () => {
    // A Slack bot token in a plain text input is the same exposure class as a
    // Discord token, which index.html already masks.
    const html = read('public/index.html');
    for (const id of ['slBotToken', 'slAppToken']) {
        const idx = html.indexOf(`id="${id}"`);
        assert.ok(idx > 0, `missing #${id}`);
        const tagStart = html.lastIndexOf('<input', idx);
        assert.match(html.slice(tagStart, idx), /type="password"/, `#${id} is not masked`);
    }
});

// ─── Guided setup card (260803 UX redesign) ─────────

test('the slack section has a 3-step setup guide card with the exact Slack click path', () => {
    const html = read('public/index.html');
    assert.ok(html.includes('class="slack-setup-card"'), 'guide card missing');
    assert.ok((html.match(/class="slack-setup-step"/g) || []).length === 3, 'expected 3 steps');
    assert.ok(html.includes('id="slack-copy-manifest"'), 'manifest copy button missing');
    assert.ok(html.includes('id="slack-open-apps"'), 'open-apps button missing');
    // The screenshot-confirmed confusion: Your Apps shows only "Create an
    // App" — the guide must name the exact path from there.
    assert.ok(html.includes('From an app manifest'), 'exact Slack click path missing');
});

test('non-credential fields are demoted to a collapsed advanced section', () => {
    const html = read('public/index.html');
    const detailsIdx = html.indexOf('<details class="slack-advanced">');
    assert.ok(detailsIdx > 0, 'advanced <details> missing');
    for (const id of ['slTeamId', 'slChannelIds', 'slMentionOn', 'slThreadOn', 'slForwardOn', 'slAllowBotsOn']) {
        assert.ok(html.indexOf(`id="${id}"`) > detailsIdx, `#${id} should live inside the advanced section`);
    }
    // Only the two credential inputs stay top-level.
    const cardIdx = html.indexOf('class="slack-setup-card"');
    assert.ok(html.indexOf('id="slBotToken"') > cardIdx && html.indexOf('id="slBotToken"') < detailsIdx);
    assert.ok(html.indexOf('id="slAppToken"') > cardIdx && html.indexOf('id="slAppToken"') < detailsIdx);
});

test('guide bindings and prefix validation are wired from settings-slack.ts', () => {
    const module = read('public/js/features/settings-slack.ts');
    assert.match(module, /initSlackSetupGuide/);
    assert.ok(module.includes("getElementById('slack-copy-manifest')"));
    assert.ok(module.includes("bindPrefixValidation('slBotToken'"));
    assert.ok(module.includes("bindPrefixValidation('slAppToken'"));
    const main = read('public/js/main.ts');
    assert.match(main, /initSlackSetupGuide\(\)/);
});

test('slack toggle defaults in the markup match the backend defaults', () => {
    // mentionOnly and replyInThread default TRUE for Slack, unlike Discord's
    // mentionOnly. A mismatched `active` class would show the toggle off while
    // the backend behaved as on.
    const html = read('public/index.html');
    const block = html.slice(html.indexOf('id="channelSlackSettings"'));
    for (const onId of ['slMentionOn', 'slThreadOn']) {
        const idx = block.indexOf(`id="${onId}"`);
        assert.ok(idx > 0, `missing #${onId}`);
        const tag = block.slice(block.lastIndexOf('<button', idx), block.indexOf('>', idx));
        assert.match(tag, /class="perm-btn active"/, `#${onId} should default active`);
    }
});

// ─── routes and manager registration ────────────────

test('the per-channel slack send route mirrors discord', () => {
    const routes = read('src/routes/messaging.ts');
    assert.ok(routes.includes(`'/api/slack/send'`), 'no /api/slack/send route');
    assert.match(routes, /channel: 'slack'/);
    // It must reuse the shared error helpers rather than inventing a shape.
    const slackBlock = routes.slice(routes.indexOf(`'/api/slack/send'`));
    assert.match(slackBlock, /sendResultHttpStatus\(result\)/);
    assert.match(slackBlock, /httpStatus\(e, 500\)/);
});

test('the manager registers the slack settings page in all three places', () => {
    // A page missing from any one of these cannot be navigated to.
    assert.match(read('public/manager/src/settings/types.ts'), /'channels-slack'/);
    assert.match(read('public/manager/src/settings/SettingsShell.tsx'), /'channels-slack': lazy\(\(\) => import\('\.\/pages\/ChannelsSlack'\)\)/);
    assert.match(read('public/manager/src/settings/SettingsSidebar.tsx'), /id: 'channels-slack'/);
});

test('manager shared components accept slack', () => {
    const toggle = read('public/manager/src/settings/pages/components/ActiveChannelToggle.tsx');
    assert.match(toggle, /'telegram' \| 'discord' \| 'slack'/);
    assert.match(toggle, /value: 'slack', label: 'Slack'/);
    const chips = read('public/manager/src/settings/pages/components/TransportStatusChips.tsx');
    assert.match(chips, /slack: TransportStatus/);
    assert.match(chips, /channel: 'telegram' \| 'discord' \| 'slack'/, 'the channel prop must accept slack');
    assert.match(chips, /\n\s+slack,\n/, 'the parser must return a slack member');
});

test('manager slack page masks both tokens', () => {
    const page = read('public/manager/src/settings/pages/ChannelsSlack.tsx');
    assert.match(page, /SecretField[\s\S]{0,200}sl-botToken/);
    assert.match(page, /SecretField[\s\S]{0,200}sl-appToken/);
});

test('the outbound-only state is surfaced on the slack page, not the shared chips', () => {
    // The shared status chips are frozen for cross-channel behavior changes, so
    // missing_app_token is explained on the Slack page itself.
    const chips = read('public/manager/src/settings/pages/components/TransportStatusChips.tsx');
    assert.ok(!chips.includes('missing_app_token'), 'shared chips must stay channel-agnostic');
    const page = read('public/manager/src/settings/pages/ChannelsSlack.tsx');
    assert.match(page, /OUTBOUND-ONLY/);
    assert.match(page, /outboundOnly/);
});

// ─── behavior (not source text) ─────────────────────

test('the slack slug is resolvable, not just present in the icon map', () => {
    // The asset and the map entry are NOT enough: resolveProviderSlug returns
    // null for an unregistered slug and providerIcon then returns '', so the
    // header icon renders empty. The module cannot be imported here because it
    // uses Vite `?raw` imports, so all three required pieces are asserted.
    const source = read('public/js/provider-icons.ts');
    assert.match(source, /\| 'slack'/, 'ProviderSlug union is missing slack');
    assert.match(source, /if \(normalized === 'slack'\) return 'slack';/, 'resolveProviderSlug has no slack branch');
    assert.match(source, /slack:\s*\{\s*color: slackSvg/, 'PROVIDER_ICONS has no slack entry');
    assert.match(source, /import slackSvg from '\.\.\/assets\/providers\/slack\.svg\?raw'/);
});

test('the slack provider asset is well-formed and matches the house convention', () => {
    const svg = read('public/assets/providers/slack.svg').trim();
    assert.match(svg, /^<svg /);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /fill="currentColor"/);
    assert.match(svg, /<title>Slack<\/title>/);
    assert.match(svg, /<\/svg>$/);
});

test('the classic health parser tolerates a pre-slack payload', async () => {
    // A newer bundle can be served against an older running server during a
    // rolling update; rejecting the payload would hide Telegram and Discord too.
    const { parseChannelHealth } = await import('../../public/js/features/transport-status-row.ts');
    const legacy = {
        channels: {
            activeInbound: 'telegram',
            telegram: { configured: true, activeInbound: true, sendCapable: true },
            discord: { configured: false, activeInbound: false, sendCapable: false },
        },
    };
    const health = parseChannelHealth(legacy);
    assert.ok(health, 'legacy two-channel payload was rejected outright');
    assert.equal(health.telegram.configured, true);
    assert.equal(health.slack.configured, false, 'slack should degrade, not vanish');
});

test('the classic health parser accepts a slack-bearing payload', async () => {
    const { parseChannelHealth } = await import('../../public/js/features/transport-status-row.ts');
    const health = parseChannelHealth({
        channels: {
            activeInbound: 'slack',
            telegram: { configured: false, activeInbound: false, sendCapable: false },
            discord: { configured: false, activeInbound: false, sendCapable: false },
            slack: { configured: true, activeInbound: true, sendCapable: true },
        },
    });
    assert.ok(health);
    assert.equal(health.activeInbound, 'slack');
    assert.equal(health.slack.sendCapable, true);
});

test('loadSlackSettings honours the true-by-default toggles', async () => {
    // A `!!` read would show mentionOnly/replyInThread off on a fresh install
    // while the backend behaved as on.
    const source = read('public/js/features/settings-slack.ts');
    assert.match(source, /const mentionOnly = sc\.mentionOnly !== false/);
    assert.match(source, /const replyInThread = sc\.replyInThread !== false/);
    // And the markup must agree: the ON button carries `active`.
    const html = read('public/index.html');
    const block = html.slice(html.indexOf('id="channelSlackSettings"'));
    const idx = block.indexOf('id="slMentionOn"');
    const tag = block.slice(block.lastIndexOf('<button', idx), block.indexOf('>', idx));
    assert.match(tag, /perm-btn active/, `slMentionOn should default active: ${tag}`);
});

// ─── parity sweep ───────────────────────────────────

test('no two-channel enumeration remains in src or the frontend', () => {
    const files = [
        'src/messaging/types.ts',
        'src/cli/types.ts',
        'public/js/features/settings-types.ts',
        'public/js/features/settings-channel.ts',
        'public/js/features/transport-status-row.ts',
        'public/manager/src/settings/pages/components/ActiveChannelToggle.tsx',
        'public/manager/src/settings/pages/components/TransportStatusChips.tsx',
    ];
    for (const file of files) {
        const source = read(file);
        assert.ok(
            !/'telegram'\s*\|\s*'discord'(?!\s*\|\s*'slack')/.test(source),
            `${file} still has a two-channel union`,
        );
    }
});
