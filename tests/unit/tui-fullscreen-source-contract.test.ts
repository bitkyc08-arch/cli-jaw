import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../bin/commands/tui/fullscreen-mode.ts', import.meta.url), 'utf8');

test('fullscreen user transcript renderer splits embedded newlines into frame rows', () => {
    assert.match(source, /function wrapPlainLines\(text: string, width: number\): string\[\]/);
    assert.match(source, /text\.split\('\\n'\)\.flatMap/);
    assert.match(source, /const bodyRows = wrapPlainLines\(item\.displayText, bodyWidth\)/);
    assert.match(source, /\.\.\.bodyRows\.map\(line =>/);
});

test('fullscreen thinking renderer returns labeled rows without embedded newline templates', () => {
    const thinkBlock = source.slice(
        source.indexOf('if (thinkMatch)'),
        source.indexOf('const mdText = item.text'),
    );
    assert.ok(thinkBlock.includes('...(agentLabel ?'));
    assert.doesNotMatch(thinkBlock, /return \[`.*\\n.*`\]/s);
});

test('fullscreen tool renderer uses transcript status and detail fields', () => {
    assert.match(source, /function parseToolText\(text: string\)/);
    assert.match(source, /LEADING_TOOL_GLYPH/);
    assert.match(source, /const toolDetail = item\.detail \?\? parsed\.detail/);
    assert.match(source, /item\.status === 'error'/);
    assert.match(source, /item\.status === 'done' \? 'done'/);
    assert.doesNotMatch(source, /item\.status === 'done' \|\| item\.collapsed/);
});

test('fullscreen completed tool expansion is full-sweep and newline-safe', () => {
    // Tool detail expansion was extracted from fullscreen-mode into renderToolBlock;
    // fullscreen-mode delegates and the bridge owns the newline-safe full sweep + row cap.
    assert.match(source, /toggleToolExpansion\(ctx\.store\.transcript\)/);
    assert.match(source, /const toolDetail = item\.detail \?\? parsed\.detail/);
    assert.match(source, /renderToolBlock\(parsed\.label, toolDetail, state, \{/);
    assert.match(source, /collapsed: item\.collapsed/);
    const bridge = readFileSync(new URL('../../src/cli/tui/jawcode-bridge.ts', import.meta.url), 'utf8');
    assert.match(bridge, /const detailLines = detail\.split\('\\n'\)/);
    assert.match(bridge, /const maxRows = 14/);
});

test('fullscreen live tool handling keeps running tools out of committed transcript', () => {
    assert.match(source, /renderLiveToolRows\(ctx, cols/);
    assert.match(source, /const state = ctx\.store\.transcript/);
    assert.match(source, /listLiveToolItems\(state\)/);
    assert.match(source, /state\.liveToolsExpanded/);
    assert.match(source, /liveRows/);
});

test('fullscreen mouse tracking is opt-in for copy-friendly native scrollback', () => {
    assert.match(source, /ctx\.tuiConfig\['mouseTracking'\] === true/);
    assert.match(source, /function isMouseTrackingEnabled\(ctx: TuiContext\): boolean/);
    assert.match(source, /const mouseTrackingEnabled = isMouseTrackingEnabled\(ctx\)/);
    assert.match(source, /mouseTrackingEnabled && isMouseSequence\(incoming\)/);
    assert.match(source, /if \(isMouseTrackingEnabled\(ctx\)\) screen\.enableMouse\(\);\s*else screen\.disableMouse\(\);/);
    assert.doesNotMatch(source, /ctx\.tuiConfig\['mouseTracking'\] !== false/);
    assert.doesNotMatch(source, /screen\.enter\(\);\s*screen\.enableMouse\(\);/);
});
