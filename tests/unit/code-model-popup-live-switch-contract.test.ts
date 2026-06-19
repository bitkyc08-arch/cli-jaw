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

test('CodeCanvas wires model popup through explicit Use now handler', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');

    assert.ok(canvas.includes('const handleUseModel = useCallback'), 'CodeCanvas must own the explicit live model handler');
    assert.ok(canvas.includes('client.setSessionModel(activeSessionId, toModelId(nextProvider, nextModel))'), 'Use now must call the existing live session model route');
    assert.ok(canvas.includes('onUseModel={handleUseModel}'), 'CodeCanvas must pass the explicit handler to the popup');
    assert.ok(canvas.includes('activeSessionId={activeSessionId}'), 'popup must know whether a Code session is active');
    assert.ok(canvas.includes('error={popupError}'), 'popup must receive live switch error state');
});

test('model popup keeps draft state separate from active model state', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');

    assert.ok(popup.includes('const [draftProvider, setDraftProvider]'), 'model popup must stage provider changes');
    assert.ok(popup.includes('const [draftModel, setDraftModel]'), 'model popup must stage model changes');
    assert.ok(popup.includes('const canUseNow'), 'model popup must compute explicit apply availability');
    assert.ok(popup.includes('Start or load a Code session to apply a live model.'), 'model popup must explain no-session apply state');
    assert.equal(popup.includes('setSessionModel'), false, 'popup component must not call transport APIs directly');
});

test('model popup offers a pre-session "Use for new sessions" apply (slice 212 settings SOT)', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    const workbench = read('public/manager/src/code/CodeWorkbench.tsx');
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');

    assert.ok(popup.includes('onUseForNewSessions'), 'popup must accept an onUseForNewSessions handler');
    assert.ok(popup.includes('Use for new sessions'), 'popup must render a "Use for new sessions" action');
    assert.ok(workbench.includes('onUseForNewSessions={props.onUseForNewSessions}'), 'workbench must thread onUseForNewSessions to the popup');
    assert.ok(canvas.includes('onUseForNewSessions={'), 'canvas must provide the pre-session apply handler');
    assert.ok(canvas.includes('requireActiveSession: false'), 'pre-session apply must not require an active session');
});
