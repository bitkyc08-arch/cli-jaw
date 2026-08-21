// Cycle 8a (parity2 080): Work/Chat surface detection, fail-closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChatGptComposerSurface, detectChatGptWorkAvailability } from '../../src/browser/web-ai/product-surfaces.ts';

function radioPage(entries: Array<{ text: string; checked: string | null; dataState: string | null; visible?: boolean }>, probeState = 'unresolved'): unknown {
    return {
        url: () => 'https://chatgpt.com/c/abc-123',
        evaluate: async () => ({ state: probeState, evidence: {} }),
        locator: () => ({
            count: async () => entries.length,
            nth: (i: number) => ({
                isVisible: async () => entries[i]?.visible !== false,
                textContent: async () => entries[i]?.text ?? '',
                getAttribute: async (name: string) => name === 'aria-checked' ? entries[i]?.checked ?? null : entries[i]?.dataState ?? null,
            }),
        }),
    };
}

test('C8-SURF-1: chat active + work inactive → chat', async () => {
    const page = radioPage([
        { text: 'Chat', checked: 'true', dataState: 'on' },
        { text: 'Work', checked: 'false', dataState: 'off' },
    ]);
    const d = await detectChatGptComposerSurface(page as never);
    assert.deepEqual({ ui: d.ui, surface: d.surface }, { ui: 'toggle', surface: 'chat' });
});

test('C8-SURF-2: work active → work; availability reflects both', async () => {
    const page = radioPage([
        { text: 'Chat', checked: 'false', dataState: 'off' },
        { text: 'Work', checked: 'true', dataState: 'on' },
    ]);
    const d = await detectChatGptComposerSurface(page as never);
    assert.equal(d.surface, 'work');
    const avail = await detectChatGptWorkAvailability(page as never);
    assert.deepEqual({ available: avail.available, active: avail.active }, { available: true, active: true });
});

test('C8-SURF-3: attribute mismatch / one-sided / both-active are AMBIGUOUS, never a guess', async () => {
    for (const entries of [
        [{ text: 'Chat', checked: 'true', dataState: 'off' }, { text: 'Work', checked: 'false', dataState: 'off' }], // mismatch
        [{ text: 'Chat', checked: 'true', dataState: 'on' }], // one-sided
        [{ text: 'Chat', checked: 'true', dataState: 'on' }, { text: 'Work', checked: 'true', dataState: 'on' }], // both active
        [{ text: 'Chat', checked: 'true', dataState: 'on' }, { text: 'Work', checked: 'false', dataState: 'off', visible: false }], // hidden work
    ] as never[]) {
        const d = await detectChatGptComposerSurface(radioPage(entries as never) as never);
        assert.equal(d.surface, 'ambiguous', JSON.stringify(entries));
    }
});

test('C8-SURF-4: no toggle radios → legacy probe decides (work conversation detected)', async () => {
    const page = radioPage([], 'work');
    const d = await detectChatGptComposerSurface(page as never);
    assert.deepEqual({ ui: d.ui, surface: d.surface }, { ui: 'legacy', surface: 'work' });
});

test('C8-SURF-5: legacy probe unresolved → surface null (send proceeds as chat-legacy)', async () => {
    const page = radioPage([], 'unresolved');
    const d = await detectChatGptComposerSurface(page as never);
    assert.deepEqual({ ui: d.ui, surface: d.surface }, { ui: 'legacy', surface: null });
});

