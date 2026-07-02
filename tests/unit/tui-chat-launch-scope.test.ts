import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const chatSource = readFileSync(join(root, 'bin/commands/chat.ts'), 'utf8');
const fullscreenSource = readFileSync(join(root, 'bin/commands/tui/fullscreen-mode.ts'), 'utf8');
const frameSource = readFileSync(join(root, 'src/cli/tui/render/frame.ts'), 'utf8');

test('fullscreen jaw chat does not hydrate persisted message history at launch', () => {
    assert.equal(chatSource.includes('/api/messages?limit='), false);
    assert.equal(chatSource.includes('hydrateFullscreenHistory'), false);
    assert.equal(chatSource.includes('hydrateTranscriptFromHistory'), false);
});

test('fullscreen jaw chat still starts from welcome prelude and live renderer', () => {
    assert.ok(chatSource.includes('ctx.welcomeLines = welcomeLines'));
    assert.ok(chatSource.includes('await runFullscreenMode(ctx)'));
});

test('fullscreen jaw chat defaults to native mouse behavior', () => {
    assert.doesNotMatch(chatSource, /mouseTracking:\s*true/);
});

test('fullscreen welcome remains in the launch prelude instead of pre-render stdout', () => {
    assert.equal(fullscreenSource.includes('function printWelcomeToScrollback'), false);
    assert.equal(fullscreenSource.includes('ctx.welcomeLines = [];'), false);
    assert.ok(fullscreenSource.includes('viewport.setPrelude(renderWelcomePrelude(ctx, cols))'));
    assert.match(fullscreenSource, /if \(isMouseTrackingEnabled\(ctx\)\) screen\.enableMouse\(\);\s*else screen\.disableMouse\(\);/);
    assert.ok(fullscreenSource.includes([
        'rebuildFooter(ctx);',
        '    screen.enter();',
        '    if (isMouseTrackingEnabled(ctx)) screen.enableMouse();',
        '    else screen.disableMouse();',
        '    scheduler.request();',
    ].join('\n')));
});

test('fullscreen scrollback commit uses queue+render pattern with transactional mark', () => {
    const commitStart = frameSource.indexOf('queueCommitLines(lines: string[]): boolean');
    const commitEnd = frameSource.indexOf('lastCommitFlushedCount(): number', commitStart);
    const commitBlock = frameSource.slice(commitStart, commitEnd);

    assert.ok(commitBlock.includes('detectHistoryLaneMode'), 'commit checks lane compatibility');
    assert.ok(commitBlock.includes('pendingCommitLines'), 'commit queues lines for render-internal flush');
    assert.ok(frameSource.includes('lastCommitFlushedCount'), 'screen reports flushed count for transactional mark');
    assert.ok(frameSource.includes('hasNativeCommit'), 'screen tracks native commit state');
    assert.ok(frameSource.includes('normalized.fillRows >= 2'), 'render flushes only when fill lane >= 2');
});

test('fullscreen resize uses JWC-like clear before transcript and protects history afterward', () => {
    const resizeStart = fullscreenSource.indexOf("process.stdout.on('resize'");
    const resizeEnd = fullscreenSource.indexOf("process.stdin.on('data'", resizeStart);
    const resizeBlock = fullscreenSource.slice(resizeStart, resizeEnd);

    assert.ok(frameSource.includes('needsResizeRepaint(): boolean'));
    assert.ok(frameSource.includes('geometryChanged(width: number, height: number): boolean'));
    assert.ok(frameSource.includes('forceResizeRedraw(): void'));
    assert.ok(frameSource.includes('hasNativeCommit'));
    assert.ok(frameSource.includes('scrollbackProtected'));
    assert.ok(frameSource.includes("resizeRepaintMode(widthChanged: boolean, heightChanged: boolean): 'discard-scrollback' | 'visible-clear' | 'viewport-only'"));
    assert.ok(frameSource.includes('buildViewportRepaintSequence'));
    assert.ok(frameSource.includes("buildFullClearSequence(mode === 'discard-scrollback')"));
    assert.ok(frameSource.includes('return buildFullClearSequence(true);'));
    assert.ok(resizeBlock.includes([
        'viewport.setWidth(process.stdout.columns || 80);',
        '        screen.forceResizeRedraw();',
        '        scheduler.request();',
        '',
        '        if (ctx.resizeTimer) clearTimeout(ctx.resizeTimer);',
    ].join('\n')), 'resize handler should request an immediate repaint before trailing debounce');
    assert.ok(fullscreenSource.includes('const hasTranscriptItems = ctx.store.transcript.items.length > 0;'));
    assert.ok(fullscreenSource.includes('computeStablePrefixIndex'));
    assert.ok(fullscreenSource.includes('peekStableCommitRows'));
    assert.ok(fullscreenSource.includes('markCommittedFrontier'));
    assert.equal(resizeBlock.includes('screen.forceRedraw();'), false);
    assert.equal(resizeBlock.includes('screen.resetViewport();'), false);
    const repaintStart = frameSource.indexOf('function buildViewportRepaintSequence');
    const repaintEnd = frameSource.indexOf('function buildFullClearSequence', repaintStart);
    const repaintBlock = frameSource.slice(repaintStart, repaintEnd);
    assert.equal(repaintBlock.includes('\\x1b[2J'), false);
    assert.equal(repaintBlock.includes('\\x1b[3J'), false);
    assert.ok(frameSource.includes('function buildLaunchClearSequence'));
    assert.ok(frameSource.includes("'\\x1b[2J\\x1b[H\\x1b[3J'"));
    assert.equal(frameSource.includes('\x1b[?1049h'), false);
});
