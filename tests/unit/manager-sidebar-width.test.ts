import assert from 'node:assert/strict';
import test from 'node:test';
import {
    SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN,
    clampSidebarWidth, resolveSidebarMaxWidth, resolveSidebarWidth,
} from '../../public/manager/src/hooks/useSidebarWidth.js';

test('max subtracts 640 and open right panel width', () => {
    assert.equal(resolveSidebarMaxWidth({ viewportWidth: 1600, rightPanelOpen: false, rightPanelWidth: 480 }), 960);
    assert.equal(resolveSidebarMaxWidth({ viewportWidth: 1600, rightPanelOpen: true, rightPanelWidth: 480 }), 480);
});

test('max never drops below MIN', () => {
    assert.equal(resolveSidebarMaxWidth({ viewportWidth: 1280, rightPanelOpen: true, rightPanelWidth: 480 }), SIDEBAR_WIDTH_MIN);
});

test('resolve uses default when stored is null', () => {
    const bounds = { viewportWidth: 1440, rightPanelOpen: false, rightPanelWidth: 0 };
    assert.equal(resolveSidebarWidth(null, bounds), SIDEBAR_WIDTH_DEFAULT);
    assert.equal(resolveSidebarWidth(180, bounds), SIDEBAR_WIDTH_MIN);
    assert.equal(clampSidebarWidth(9000, bounds), resolveSidebarMaxWidth(bounds));
});
