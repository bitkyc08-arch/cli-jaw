import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getInteractive,
    initJawcodeTui,
    isInitialized,
    renderMarkdownJawcode,
} from '../../src/cli/tui/jawcode-render.ts';

// The jawcode TUI renderer loads the pi_natives native addon. On hosts where the
// platform-specific .node addon is not built (e.g. a fresh dev checkout), skip
// cleanly instead of failing — these are environment gaps, not regressions.
let nativeSkip: string | false = false;
try {
    await initJawcodeTui();
} catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown })?.code;
    if (msg.includes('pi_natives')) nativeSkip = 'pi_natives native addon not built for this platform';
    // A bundle-less build raises JawcodeBundleMissingError (or, on older builds, a
    // raw ERR_MODULE_NOT_FOUND for bun-shim.mjs / the bundle). Treat all as skips.
    else if (code === 'JAWCODE_BUNDLE_MISSING'
        || msg.includes('jawcode-tui-bundle.mjs')
        || msg.includes('bun-shim.mjs')) nativeSkip = 'jawcode TUI bundle not built in this checkout';
    else throw err;
}

test('renderMarkdownJawcode renders headings without exported getMarkdownTheme', { skip: nativeSkip }, async () => {
    await initJawcodeTui();
    assert.equal(isInitialized(), true);
    assert.equal(typeof getInteractive().getMarkdownTheme, 'undefined');

    const lines = renderMarkdownJawcode('# Hello', 80);
    assert.ok(lines.length > 0);
    assert.ok(lines.join('\n').includes('Hello'));
});

test('renderMarkdownJawcode renders common markdown blocks', { skip: nativeSkip }, async () => {
    await initJawcodeTui();
    const lines = renderMarkdownJawcode('## Title\n\n- one\n- two\n\n```ts\nconst x = 1;\n```', 80);
    const out = lines.join('\n');
    assert.ok(out.includes('Title'));
    assert.ok(out.includes('one'));
    assert.ok(out.includes('const x = 1'));
});

test('renderMarkdownJawcode renders tables without missing symbol theme', { skip: nativeSkip }, async () => {
    await initJawcodeTui();
    const lines = renderMarkdownJawcode('| A | B |\n|---|---|\n| 1 | 2 |', 80);
    const out = lines.join('\n');
    assert.ok(out.includes('A'));
    assert.ok(out.includes('1'));
    assert.ok(out.includes('┌') || out.includes('| A | B |'));
});

test('renderMarkdownJawcode can be called repeatedly after one initialization', { skip: nativeSkip }, async () => {
    await initJawcodeTui();
    const first = renderMarkdownJawcode('plain text', 80);
    const second = renderMarkdownJawcode('plain text', 80);
    assert.deepEqual(second, first);
});
