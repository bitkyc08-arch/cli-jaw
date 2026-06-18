import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const refreshHookSource = readFileSync('public/manager/src/folder-panel/use-folder-visible-refresh.ts', 'utf8');

test('folder visible refresh coalesces filesystem watch events', () => {
    assert.ok(refreshHookSource.includes('WATCH_REFRESH_DELAY_MS'), 'watch refresh must use an explicit debounce window');
    assert.ok(refreshHookSource.includes('watchTimerRef'), 'watch refresh must own a timer ref for coalescing');
    assert.ok(refreshHookSource.includes('window.clearTimeout(watchTimerRef.current)'), 'new watch events must clear the previous timer');
    assert.ok(refreshHookSource.includes("void runRefresh('watch')"), 'watch timer must use the same visible refresh path');
});

test('folder visible refresh preserves one queued refresh during active work', () => {
    assert.ok(refreshHookSource.includes('refreshingRef.current'), 'refresh hook must track active refresh work');
    assert.ok(refreshHookSource.includes('queuedRefreshRef'), 'refresh hook must retain one queued refresh request');
    assert.ok(refreshHookSource.includes('queued.options.extraPaths'), 'queued refresh must preserve affected visible paths');
    assert.ok(refreshHookSource.includes('void runRefresh(queuedRefresh.reason, queuedRefresh.options)'), 'queued refresh must rerun through the same path');
});

test('folder watch registration cleans up timers and native watchers', () => {
    assert.ok(refreshHookSource.includes('source.watchDir?.(rootPath)'), 'hook must register the current root watcher');
    assert.ok(refreshHookSource.includes('source.onDirChange(() => { scheduleWatchRefresh(); })'), 'hook must subscribe directory changes');
    assert.ok(refreshHookSource.includes('clearWatchTimer();'), 'hook cleanup must clear pending watch timers');
    assert.ok(refreshHookSource.includes('source.unwatchDir?.(rootPath)'), 'hook cleanup must unwatch the old root');
});
