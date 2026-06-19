import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const popup = readFileSync(join(root, 'public/manager/src/code/CodeCommandPopup.tsx'), 'utf8');
const css = readFileSync(join(root, 'public/manager/src/code/code-command-popup-model.css'), 'utf8');

// Slice 214: the /model popup is split into Models / Roles / Profiles tabs so the
// primary model action is no longer buried under role assignment + profiles.

test('model popup uses an accessible tablist with three tabs', () => {
    assert.ok(popup.includes("useState<'models' | 'roles' | 'profiles'>('models')"), 'popup owns modelTab state defaulting to models');
    assert.ok(popup.includes('role="tablist"'), 'tabs use a tablist container');
    assert.ok(popup.includes('role="tab"'), 'each tab is role=tab');
    assert.ok(popup.includes('aria-selected={modelTab === tab}'), 'active tab is aria-selected');
    assert.ok(popup.includes('aria-controls={`code-model-panel-${tab}`}'), 'tabs reference their panels');
    for (const label of ['Models', 'Roles', 'Profiles']) {
        assert.ok(popup.includes(label), `tablist must offer the ${label} tab`);
    }
    // Keyboard navigation between tabs (both arrow keys handled in the tab onKeyDown).
    assert.ok(popup.includes("'ArrowRight'") && popup.includes("'ArrowLeft'") && popup.includes('onKeyDown'), 'tabs support arrow-key navigation');
});

test('each model tab renders its region behind a tabpanel gate', () => {
    assert.ok(popup.includes("modelTab === 'models'") , 'Models region is gated by modelTab');
    assert.ok(popup.includes("modelTab === 'roles'"), 'Roles region is gated by modelTab');
    assert.ok(popup.includes("modelTab === 'profiles'"), 'Profiles region is gated by modelTab');
    assert.ok((popup.match(/role="tabpanel"/g) ?? []).length >= 3, 'three tabpanels exist');
    // The moved regions are still present (pure move, not a rewrite).
    assert.ok(popup.includes('code-role-assignment-panel'), 'role assignment panel preserved');
    assert.ok(popup.includes('code-model-preset-panel'), 'preset panel preserved');
    assert.ok(popup.includes('Search models'), 'model search preserved');
    assert.ok(css.includes('.code-model-tablist') && css.includes('.code-model-tab'), 'tablist styles exist');
});
