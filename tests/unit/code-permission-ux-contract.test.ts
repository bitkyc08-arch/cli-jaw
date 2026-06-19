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
// - The default permission mode stays 'ask' — moving to always-allow is a separate,
//   security-sensitive decision and must NOT be silently introduced here.

test('permission selector renders for both /settings and /permission popups', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    assert.ok(popup.includes("if (kind === 'permission') return 'Permissions'"), 'titleForPopup must title the permission popup');
    assert.ok(popup.includes("popupKind === 'settings' || popupKind === 'permission'"), 'permission selector must render under both settings and permission kinds');
    assert.ok(popup.includes('aria-label') || popup.includes('<span>Permission mode</span>'), 'permission selector must be labelled');
    // The provider/model summary stays scoped to /settings only.
    assert.ok(popup.includes("popupKind === 'settings' && (") , 'provider/model summary stays settings-scoped');
});

test('permission mode is one shared state across footer and popup, default Ask (no silent security change)', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const footer = read('public/manager/src/code/ComposerFooter.tsx');
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');

    assert.ok(canvas.includes("useState<PermissionMode>('ask')"), 'default permission mode must remain ask');
    assert.equal(canvas.includes("useState<PermissionMode>('always-allow')"), false, 'must not silently default to always-allow (security)');
    // Same setter wired to both footer and popup.
    assert.ok(canvas.includes('onPermissionModeChange={setPermissionMode}'), 'CodeCanvas owns the single permission state setter');
    assert.ok(footer.includes('onPermissionModeChange'), 'footer drives the shared permission state');
    assert.ok(popup.includes('onPermissionModeChange'), 'popup drives the shared permission state');
});
