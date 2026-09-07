import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const src = (path: string) => readFileSync(join(root, path), 'utf8');

test('GROK-FE-001: provider icons include local Grok SVG assets and aliases', () => {
    const icons = src('public/js/provider-icons.ts');
    const colorSvg = src('public/assets/providers/grok-color.svg');
    const monoSvg = src('public/assets/providers/grok.svg');
    assert.match(icons, /grok-color\.svg\?raw/);
    assert.match(icons, /grok\.svg\?raw/);
    assert.match(icons, /normalized\.startsWith\('grok'\)/);
    assert.match(icons, /label:\s*'Grok'/);
    for (const svg of [colorSvg, monoSvg]) {
        assert.match(svg, /<svg[^>]+viewBox=/);
        assert.doesNotMatch(svg, /<script|<style|(?:href|src)=["']https?:\/\//);
    }
});

test('KIRO-FE-001: provider icons include local Kiro SVG assets and aliases', () => {
    const icons = src('public/js/provider-icons.ts');
    const colorSvg = src('public/assets/providers/kiro-color.svg');
    const monoSvg = src('public/assets/providers/kiro.svg');
    assert.match(icons, /kiro-color\.svg\?raw/);
    assert.match(colorSvg, /viewBox="0 0 24 24"/);
    assert.match(icons, /kiro\.svg\?raw/);
    assert.match(icons, /normalized === 'kirocode'/);
    assert.match(icons, /'kiro-code':\s*\{[\s\S]*label:\s*'Kiro'/);
    for (const svg of [colorSvg, monoSvg]) {
        assert.match(svg, /<svg[^>]+viewBox=/);
        assert.doesNotMatch(svg, /<script|<style|(?:href|src)=["']https?:\/\//);
    }
});

test('CURSOR-FE-001: provider icons use official local Cursor SVG assets', () => {
    const icons = src('public/js/provider-icons.ts');
    const colorSvg = src('public/assets/providers/cursor-color.svg');
    const monoSvg = src('public/assets/providers/cursor.svg');
    assert.match(icons, /cursor-color\.svg\?raw/);
    assert.match(icons, /cursor\.svg\?raw/);
    assert.match(icons, /normalized === 'cursor'/);
    assert.match(icons, /label:\s*'Cursor'/);
    for (const svg of [colorSvg, monoSvg]) {
        assert.match(svg, /<svg[^>]+viewBox=/);
        assert.match(svg, /https:\/\/cursor\.com\/en-US\/brand/);
        assert.doesNotMatch(svg, /<script|<style|(?:href|src)=["']https?:\/\//);
    }
});

test('CODEX-FE-001: provider icons keep codex original and color only codex-app', () => {
    const icons = src('public/js/provider-icons.ts');
    assert.match(icons, /'codex-app'/);
    assert.match(icons, /normalized === 'codexapp'/);
    assert.match(icons, /codex:\s*\{\s*color:\s*openaiSvg,\s*mono:\s*openaiSvg/);
    assert.match(icons, /'codex-app':\s*\{\s*color:\s*openaiColorSvg,\s*mono:\s*openaiSvg/);
    assert.match(icons, /codex:\s*\{[\s\S]*label:\s*'Codex'/);
    assert.match(icons, /'codex-app':\s*\{[\s\S]*label:\s*'Codex App'/);
    assert.doesNotMatch(icons, /Codex \(OpenAI\)|Codex App \(OpenAI\)/);
    assert.match(icons, /copilot:\s*\{[\s\S]*label:\s*'Copilot'/);
    assert.doesNotMatch(icons, /GitHub Copilot/);
    assert.doesNotMatch(src('public/assets/providers/copilot.svg'), /GitHub Copilot/);
    assert.doesNotMatch(src('public/assets/providers/copilot-color.svg'), /GitHub Copilot/);
});

test('CLAUDE-E-FE-001: frontend presents claude-e as Claude E', () => {
    const meta = src('public/manager/src/settings/pages/components/agent/agent-meta.ts');
    const constants = src('public/js/constants.ts');
    const icons = src('public/js/provider-icons.ts');
    const settingsCore = src('public/js/features/settings-core.ts');
    const cliStatus = src('public/js/features/settings-cli-status.ts');
    assert.match(meta, /'claude-e':\s*\{[\s\S]*label:\s*'Claude E'/);
    assert.match(constants, /'claude-e':\s*\{[\s\S]*label:\s*'Claude E'/);
    assert.match(icons, /'claude-e':\s*'Claude E'/);
    assert.match(settingsCore, /cliDisplayLabel\(cli\)/);
    assert.match(cliStatus, /providerLabel\(name\)/);
});

test('GROK-FE-002: legacy settings fallback registry exposes grok-build without effort', () => {
    const constants = src('public/js/constants.ts');
    assert.match(constants, /grok:\s*\{/);
    assert.match(constants, /label:\s*'Grok'/);
    assert.match(constants, /models:\s*\['grok-build', 'grok-composer-2\.5-fast'\]/);
    assert.match(constants, /efforts:\s*\[\]/);
    assert.match(constants, /unsupported by grok-build/);
    assert.match(constants, /'kiro-code':\s*\{/);
    assert.match(constants, /label:\s*'Kiro'/);
    assert.match(constants, /models:\s*\[\s*'auto'/);
});

test('LEGACY-FE-001: classic active/flush selector exposes every canonical CLI; per-CLI rows live in the unified settings frame', () => {
    const html = src('public/index.html');
    const agent = src('public/manager/src/settings/pages/Agent.tsx');
    for (const cli of ['ai-e', 'claude', 'codex', 'codex-app', 'cursor', 'kiro-code', 'gemini', 'grok', 'opencode', 'copilot'] as const) {
        assert.match(html, new RegExp(`<option value="${cli}"`), `active/flush selector must include ${cli}`);
    }
    // The classic per-CLI settings rows were replaced by the standalone SettingsShell iframe (260908 wp4);
    // the React Agent page owns per-CLI provider/model rows and hides claude-e from the active runtime list.
    assert.match(html, /<iframe class="settings-frame" src="dist\/settings\/index.html"/);
    assert.match(agent, /perCli\[next\]\?\.provider \|\| nextMeta\.defaultProvider/);
});

test('GROK-FE-003: quota renderer shows setup commands for status-only CLIs', () => {
    const status = `${src('public/js/features/settings-cli-status.ts')}\n${src('public/js/features/settings-cli-status-render.ts')}`;
    assert.match(status, /q\?\.quotaCapable === false/);
    assert.match(status, /describeStatusOnlyQuota/);
    assert.match(status, /QUOTA_SETUP_HINTS/);
    assert.match(status, /renderQuotaSetupBox/);
    assert.match(status, /grok login --oauth/);
    assert.match(status, /OPENCODE_GO_API_KEY/);
    assert.match(status, /data-cli-help-links/);
    assert.match(status, /github\.com\/anomalyco\/opencode\/issues\/16017/);
    assert.match(status, /zen\/go\/v1\/usage/);
    assert.match(status, /https:\/\/x\.ai\/cli\/install\.sh/, 'Grok install hint should point to xAI native installer');
    const forbiddenClaims = [
        ['Grok ', 'unlimited'].join(''),
        ['Grok quota ', '0%'].join(''),
        ['Grok quota ', '100%'].join(''),
    ];
    for (const claim of forbiddenClaims) {
        assert.ok(!status.includes(claim), `status renderer must not contain ${claim}`);
    }
});

test('GROK-FE-004: manager settings metadata treats Grok as normal CLI with disabled effort', () => {
    const meta = src('public/manager/src/settings/pages/components/agent/agent-meta.ts');
    const employees = src('public/manager/src/settings/pages/components/employees-helpers.ts');
    assert.match(meta, /grok:\s*\{/);
    assert.match(meta, /models:\s*\['grok-build', 'grok-composer-2\.5-fast'\]/);
    assert.match(meta, /efforts:\s*\[\]/);
    assert.match(employees, /'grok'/);
    assert.match(meta, /'codex-app':\s*\{/);
});

test('LEGACY-FE-002: fallback CLI surfaces include every canonical CLI', () => {
    const employees = src('public/manager/src/settings/pages/components/employees-helpers.ts');
    const heartbeat = src('public/manager/src/settings/pages/components/heartbeat-helpers.ts');
    const status = src('public/js/features/settings-cli-status.ts');
    const freshInstallSmoke = src('scripts/fresh-install-smoke.ts');
    for (const cli of ['ai-e', 'claude', 'claude-e', 'codex', 'codex-app', 'copilot', 'cursor', 'kiro-code', 'grok', 'opencode']) {
        assert.match(employees, new RegExp(`'${cli}'`), `manager employee fallback must include ${cli}`);
        assert.match(heartbeat, new RegExp(`'${cli}'`), `manager heartbeat fallback must include ${cli}`);
        assert.match(status, new RegExp(`'${cli}'|${cli}:`), `legacy CLI status hints must include ${cli}`);
        assert.match(freshInstallSmoke, new RegExp(`'${cli}'`), `fresh install smoke must assert ${cli} status`);
    }
});

test('AI-E-FE-001: legacy active settings store provider only in perCli', () => {
    const settingsCore = src('public/js/features/settings-core.ts');
    const saveActive = settingsCore.match(/export async function saveActiveCliSettings\(\): Promise<void> \{[\s\S]*?\n\}/)?.[0] || '';
    assert.match(saveActive, /patch\['perCli'\]\s*=\s*\{\s*\[cli\]:\s*\{\s*provider:/);
    assert.doesNotMatch(saveActive, /overrides\[cli\]\.provider\s*=/);
});

test('AI-E-FE-002: provider change updates perCli provider before model/effort are re-resolved (Agent page)', () => {
    const agent = src('public/manager/src/settings/pages/Agent.tsx');
    const start = agent.indexOf('onProviderChange={(next) => {');
    assert.ok(start >= 0, 'Agent page must own the provider change handler');
    const handler = agent.slice(start, agent.indexOf('onModelChange', start));
    const draftIdx = handler.indexOf('setRuntimeDraft({ ...draft, provider: next');
    const providerIdx = handler.indexOf("setEntry(`perCli.${draft.cli}.provider`");
    const modelIdx = handler.indexOf("setEntry(`activeOverrides.${draft.cli}.model`");
    assert.ok(draftIdx >= 0 && providerIdx > draftIdx, 'provider change must sync the per-CLI provider entry after updating the draft');
    assert.ok(modelIdx > providerIdx, 'model override must be written after the provider entry');
});

