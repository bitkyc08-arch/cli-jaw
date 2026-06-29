import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const refreshHookSource = readFileSync('public/manager/src/folder-panel/use-folder-visible-refresh.ts', 'utf8');
const folderIpcSource = readFileSync('electron/src/main/lib/folder/ipc.ts', 'utf8');

test('folder visible refresh coalesces filesystem watch events', () => {
    assert.ok(refreshHookSource.includes('WATCH_REFRESH_DELAY_MS'), 'watch refresh must use an explicit debounce window');
    assert.ok(refreshHookSource.includes('watchTimerRef'), 'watch refresh must own a timer ref for coalescing');
    assert.ok(refreshHookSource.includes('window.clearTimeout(watchTimerRef.current)'), 'new watch events must clear the previous timer');
    assert.ok(refreshHookSource.includes("void runRefreshRef.current('watch')"), 'watch timer must use the latest visible refresh path');
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

test('folder watch refresh keeps subscriptions stable while using the latest refresh closure', () => {
    assert.ok(refreshHookSource.includes('const runRefreshRef = useRef'), 'watch timer must call through a stable refresh ref');
    assert.ok(refreshHookSource.includes('useEffect(() => { runRefreshRef.current = runRefresh; }, [runRefresh])'), 'refresh ref must be updated when refresh dependencies change');
    assert.ok(refreshHookSource.includes("void runRefreshRef.current('watch')"), 'watch timer must avoid depending directly on the changing runRefresh callback');
    assert.ok(refreshHookSource.includes('}, [clearWatchTimer]);'), 'watch scheduler must remain stable across expanded/cache state changes');
});

test('electron folder watcher covers nested project changes on macOS without exhausting the old four-watch cap', () => {
    assert.ok(folderIpcSource.includes('const MAX_WATCHERS = 32'), 'folder watchers must allow multiple panels/instances before hitting the cap');
    assert.ok(folderIpcSource.includes("const WATCH_RECURSIVE = process.platform === 'darwin'"), 'recursive watch must be gated to macOS support');
    assert.ok(folderIpcSource.includes('watch(resolved, { recursive: WATCH_RECURSIVE }'), 'watchDir must subscribe recursively where supported');
});
