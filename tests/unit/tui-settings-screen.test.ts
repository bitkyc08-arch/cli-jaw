import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildAppearanceRows,
    composeSettingsScreenLines,
    nextAppearancePatch,
    type SettingsRow,
} from '../../src/cli/tui/settings-screen.ts';
import { clipTextToCols } from '../../src/cli/tui/renderers.ts';

test('buildAppearanceRows renders safe strings from partial settings', () => {
    const rows = buildAppearanceRows({
        settings: { showReasoning: null, tui: { theme: { bad: true }, pasteCollapseLines: {} } },
        tuiConfig: { pasteCollapseChars: undefined },
        footerPreview: 'footer',
    });

    assert.ok(rows.find(row => row.label === 'Theme'));
    assert.ok(rows.find(row => row.label === 'Reasoning Visibility'));
    assert.ok(rows.find(row => row.label === 'Compact Density'));
    assert.ok(rows.find(row => row.label === 'Markdown Renderer'));
    assert.ok(rows.find(row => row.label === 'Tool Rows'));
    assert.ok(rows.find(row => row.label === 'Composer Pin'));
    assert.equal(rows.some(row => /Context|Memory/.test(row.label)), false);
    assert.deepEqual([...new Set(rows.map(row => row.scope))], ['cli', 'web-ai', 'runtime']);
    assert.equal(rows.some(row => row.value.includes('\n')), false);
});

test('composeSettingsScreenLines is frame safe and highlights selected row', () => {
    const lines = composeSettingsScreenLines({
        settings: { showReasoning: true, tui: { theme: 'light', fullscreen: false } },
        tuiConfig: { pasteCollapseLines: 2, pasteCollapseChars: 160 },
        footerPreview: '\x1b[36mstatus\x1b[0m',
    }, {
        selected: 1,
        message: 'Saved Fullscreen Default',
    }, {
        columns: 88,
        height: 16,
        cyanCode: '\x1b[36m',
        dimCode: '\x1b[2m',
        boldCode: '\x1b[1m',
        resetCode: '\x1b[0m',
        clipTextToCols,
    });

    const joined = lines.join('\n');
    assert.equal(lines.length, 16);
    assert.equal(lines.some(line => line.includes('\n')), false);
    assert.match(joined, /Settings:/);
    assert.match(joined, /Preview:/);
    assert.match(joined, /Fullscreen Default/);
    assert.match(joined, /\x1b\[36m\x1b\[1m› Fullscreen Default/);
    assert.doesNotMatch(joined, /Context/);
    assert.doesNotMatch(joined, /Memory/);
    assert.match(joined, /Local CLI \/ TUI/);
    assert.match(joined, /Web AI Settings/);
});

test('nextAppearancePatch returns real patches only for editable rows', () => {
    const snapshot = {
        settings: { showReasoning: false, tui: { theme: 'dark', fullscreen: true, keymapPreset: 'default', diffStyle: 'summary' } },
        tuiConfig: { pasteCollapseLines: 2, pasteCollapseChars: 160 },
        footerPreview: '',
    };
    const rows = buildAppearanceRows(snapshot);
    const byId = (id: string): SettingsRow => {
        const row = rows.find(r => r.id === id);
        assert.ok(row);
        return row;
    };

    assert.deepEqual(nextAppearancePatch(byId('theme'), snapshot), { tui: { theme: 'light' } });
    assert.deepEqual(nextAppearancePatch(byId('fullscreenDefault'), snapshot), { tui: { fullscreen: false } });
    assert.deepEqual(nextAppearancePatch(byId('showReasoning'), snapshot), { showReasoning: true });
    assert.deepEqual(nextAppearancePatch(byId('compactDensity'), snapshot), { tui: { pasteCollapseLines: 4, pasteCollapseChars: 260 } });
    assert.deepEqual(nextAppearancePatch(byId('pasteCollapseLines'), snapshot), { tui: { pasteCollapseLines: 4 } });
    assert.deepEqual(nextAppearancePatch(byId('pasteCollapseChars'), snapshot), { tui: { pasteCollapseChars: 260 } });
    assert.deepEqual(nextAppearancePatch(byId('keymapPreset'), snapshot), { tui: { keymapPreset: 'vim' } });
    assert.deepEqual(nextAppearancePatch(byId('diffStyle'), snapshot), { tui: { diffStyle: 'full' } });
    assert.equal(nextAppearancePatch(byId('markdownRenderer'), snapshot), null);
    assert.equal(nextAppearancePatch(byId('toolRows'), snapshot), null);
});

test('Activity presentation defaults independently of provider and reverses to legacy', () => {
    for (const settings of [{}, { perCli: { cursor: { transport: 'print' } } },
        { perCli: { cursor: { transport: 'native' } } }]) {
        const snapshot = { settings, tuiConfig: {}, footerPreview: '' };
        const row = buildAppearanceRows(snapshot).find(row => row.id === 'presentation');
        assert.ok(row);
        assert.equal(row.value, 'activity');
        assert.deepEqual(nextAppearancePatch(row, snapshot), { presentation: { mode: 'legacy' } });
    }
    const snapshot = { settings: { presentation: { mode: 'legacy' } }, tuiConfig: {}, footerPreview: '' };
    const row = buildAppearanceRows(snapshot).find(row => row.id === 'presentation');
    assert.ok(row);
    assert.equal(row.value, 'legacy');
    assert.deepEqual(nextAppearancePatch(row, snapshot), { presentation: { mode: 'activity' } });
});
