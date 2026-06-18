import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStrictPropertyAccess } from './source-normalize.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

function read(path: string): string {
    return normalizeStrictPropertyAccess(readFileSync(join(root, path), 'utf8'));
}

test('code command popup routes popup commands through CodeCanvas state', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const composer = read('public/manager/src/code/CodeComposer.tsx');

    assert.ok(canvas.includes('activePopup'), 'CodeCanvas must own popup state');
    assert.ok(canvas.includes("command.actionType === 'popup' && command.popupKind"), 'popup commands must branch before text insertion');
    assert.ok(canvas.includes('setActivePopup({ kind: command.popupKind, command })'), 'popup branch must open popup state');
    assert.ok(canvas.includes('<CodeCommandPopup'), 'CodeCanvas must render the popup host');
    assert.ok(composer.includes('props.onCommandSelect(command)'), 'CodeComposer must remain a palette surface, not popup router');
});

test('code command popup exposes dialog and provider inventory states', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    const cssEntry = read('public/manager/src/code/code.css');

    assert.ok(popup.includes('role="dialog"'), 'popup must expose dialog semantics');
    assert.ok(popup.includes('aria-modal="true"'), 'popup must be modal to assistive tech');
    assert.ok(popup.includes("event.key === 'Escape'"), 'popup must close on Escape');
    assert.ok(popup.includes('modelOptions.providers.map'), 'provider popup must render returned provider inventory');
    assert.ok(popup.includes('modelOptions.degraded'), 'provider popup must explain degraded fallback');
    assert.ok(popup.includes('onRefreshProviders'), 'provider popup must expose refresh action');
    assert.ok(popup.includes('Provider add/login execution is next slice.'), 'provider popup must not overclaim add/login execution');
    assert.ok(cssEntry.includes("@import './code-command-popup.css';"), 'Code mode CSS entry must import popup CSS');
});

test('code command popup stages model selection before explicit Use now', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    const css = read('public/manager/src/code/code-command-popup.css');

    assert.ok(popup.includes('modelQuery'), 'model popup must own search query state');
    assert.ok(popup.includes('draftProvider'), 'model popup must stage provider selection');
    assert.ok(popup.includes('draftModel'), 'model popup must stage model selection');
    assert.ok(popup.includes('Search models'), 'model popup must expose search UI');
    assert.ok(popup.includes('Use now'), 'model popup must expose explicit live switch action');
    assert.ok(popup.includes('onUseModel(draftProvider, draftModel)'), 'model popup must apply only through explicit Use now callback');
    assert.equal(popup.includes('onModelChange(event.target.value)'), false, 'model popup must not mutate session on select-only changes');
    assert.ok(css.includes('.code-model-layout'), 'model popup must have a dedicated model browser layout');
});

test('code command popup exposes all JWC model role assignments', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const css = read('public/manager/src/code/code-command-popup.css');

    assert.ok(popup.includes('modelAssignments?.roles'), 'popup must render role assignment readback');
    assert.ok(popup.includes('Role assignments'), 'popup must label the assignment section');
    assert.ok(popup.includes('Assign selected'), 'popup must expose assignment action');
    assert.ok(popup.includes("roleThinking === 'inherit' ? null : roleThinking"), 'assignment action must map inherit to no thinking suffix');
    assert.ok(popup.includes("value === 'min' ? 'minimal' : value"), 'popup must normalize display min to canonical minimal');
    assert.ok(popup.includes('onSetModelAssignment('), 'assignment action must call assignment handler');
    assert.ok(popup.includes('onClearModelAssignment(role.role)'), 'popup must expose clear action');
    assert.ok(popup.includes('Thinking'), 'role cards must expose a thinking selector');
    assert.equal(popup.includes('Subagent assignment, presets, and MRU are scheduled for later model popup slices.'), false, 'subagent assignment must not be described as future work');

    for (const role of ['DEFAULT', 'EXECUTOR_EXT', 'EXECUTOR', 'ARCHITECT', 'PLANNER', 'CRITIC']) {
        assert.ok(read('src/code-mode/model-options.ts').includes(role), `model assignment target must include ${role}`);
    }

    assert.ok(canvas.includes('const [modelAssignments, setModelAssignments]'), 'CodeCanvas must own assignment readback state');
    assert.ok(canvas.includes('const [modelPresets, setModelPresets]'), 'CodeCanvas must own preset readback state');
    assert.ok(canvas.includes('client.listModelAssignments()'), 'CodeCanvas must load role assignments');
    assert.ok(canvas.includes('client.listModelPresets()'), 'CodeCanvas must load model presets');
    assert.ok(canvas.includes('client.setModelAssignment(role, {'), 'CodeCanvas must persist structured role assignment');
    assert.ok(canvas.includes('thinkingLevel !== undefined'), 'CodeCanvas must pass role thinking into structured assignment when selected');
    assert.ok(canvas.includes('client.clearModelAssignment(role)'), 'CodeCanvas must clear role assignment');
    assert.ok(css.includes('.code-role-assignment-grid'), 'role assignment panel must have dedicated layout styles');
    assert.ok(css.includes('.code-role-card'), 'role assignment cards must be styled');
    assert.ok(css.includes('.code-role-thinking'), 'role assignment thinking selector must be styled');
});

test('code command popup exposes read-only model profile preset state', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    const css = read('public/manager/src/code/code-command-popup.css');

    assert.ok(popup.includes('modelPresets'), 'popup must accept model preset readback');
    assert.ok(popup.includes('Profiles and presets'), 'model popup must label profile/preset section');
    assert.ok(popup.includes('Startup profile'), 'profile section must show startup profile');
    assert.ok(popup.includes('Task presets'), 'profile section must show task preset count');
    assert.ok(popup.includes('Apply profile'), 'profile section must expose disabled apply affordance');
    assert.ok(popup.includes('JWC runtime owns credential checks and rollback'), 'profile section must explain why apply is deferred');
    assert.equal(popup.includes('Presets and MRU are scheduled for later model popup slices.'), false, 'preset section must not be stale future-work copy');
    assert.ok(css.includes('.code-model-preset-panel'), 'preset panel must have dedicated styles');
    assert.ok(css.includes('.code-model-profile-chips'), 'profile chips must have dedicated styles');
});

test('code command popup exposes JWC model usage MRU without fake history', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    const client = read('public/manager/src/code/code-session-client.ts');
    const css = read('public/manager/src/code/code-command-popup.css');

    assert.ok(client.includes('usageOrder?: string[]'), 'model options contract must carry optional JWC usage order');
    assert.ok(popup.includes('modelOptions.usageOrder'), 'model popup must read usage order from model options');
    assert.ok(popup.includes('Recently used'), 'model popup must label MRU models');
    assert.ok(popup.includes('modelOptions.usageOrder.slice(0, 3)'), 'model popup must cap MRU display');
    assert.equal(popup.includes('MRU are scheduled for later model popup slices.'), false, 'MRU must not be stale future-work copy');
    assert.ok(css.includes('.code-model-mru-strip'), 'MRU strip must have compact styles');
});

test('code command popup stays instance-independent', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');

    assert.equal(popup.includes('selectedInstance'), false, 'popup must not depend on manager instance selection');
    assert.equal(canvas.includes('selectedInstance'), false, 'CodeCanvas popup routing must remain instance-independent');
});
