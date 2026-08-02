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
    assert.match(chips, /slack: row\['slack'\]/, 'the parser must return the slack member');
});

test('manager slack page masks both tokens', () => {
    const page = read('public/manager/src/settings/pages/ChannelsSlack.tsx');
    assert.match(page, /SecretField[\s\S]{0,200}sl-botToken/);
    assert.match(page, /SecretField[\s\S]{0,200}sl-appToken/);
});

test('transport status chips surface the reason code', () => {
    // Without this a Slack instance stuck on missing_app_token reads as simply
    // "Configured" with no explanation.
    const chips = read('public/manager/src/settings/pages/components/TransportStatusChips.tsx');
    assert.match(chips, /missing_app_token/);
    assert.match(chips, /status\.reason/);
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
