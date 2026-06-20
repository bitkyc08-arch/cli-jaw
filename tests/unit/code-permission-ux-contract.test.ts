import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

// Slice 215: permission UX consolidation.
// - The /permission popup must render the permission selector (titleForPopup already
//   returns 'Permissions'; previously no popupKind==='permission' branch rendered controls).
// - Footer and popup share one permission state.
// Slice 321: the security-sensitive default changed with explicit user approval:
//   new Code mode sessions default to always-allow, and the popup must make that
//   policy visible without falling back to a native select.

test('permission selector renders for both /settings and /permission popups', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    assert.ok(popup.includes("if (kind === 'permission') return 'Permissions'"), 'titleForPopup must title the permission popup');
    assert.ok(popup.includes("popupKind === 'settings' || popupKind === 'permission'"), 'permission selector must render under both settings and permission kinds');
    assert.ok(popup.includes('CodePermissionModePicker'), 'permission selector must use the shared custom picker');
    assert.equal(popup.includes('<select value={permissionMode}'), false, 'permission popup must not use a native select');
    // The provider/model summary stays scoped to /settings only.
    assert.ok(popup.includes("popupKind === 'settings' && (") , 'provider/model summary stays settings-scoped');
});

test('permission mode is one shared state across footer and popup, default always-allow by explicit decision', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const footer = read('public/manager/src/code/ComposerFooter.tsx');
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    const picker = read('public/manager/src/code/CodePermissionModePicker.tsx');

    assert.ok(canvas.includes("useState<PermissionMode>('always-allow')"), 'default permission mode must be always-allow after explicit approval');
    assert.equal(canvas.includes("useState<PermissionMode>('ask')"), false, 'new Code sessions must no longer default to ask');
    // Same setter wired to both footer and popup.
    assert.ok(canvas.includes('onPermissionModeChange={setPermissionMode}'), 'CodeCanvas owns the single permission state setter');
    assert.ok(footer.includes('onPermissionModeChange'), 'footer drives the shared permission state');
    assert.ok(popup.includes('onPermissionModeChange'), 'popup drives the shared permission state');
    assert.ok(picker.includes('Default: Always allow'), 'popup copy must name the new default');
    assert.ok(picker.includes('transcript audit row'), 'popup copy must state that automatic answers remain audited');
});
