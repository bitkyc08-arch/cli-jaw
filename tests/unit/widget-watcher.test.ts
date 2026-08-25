import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { startWidgetWatcher } from '../../src/core/widget-watcher.ts';
import { WIDGETS_DIR } from '../../src/core/config.ts';
import { subscribe, type BusEvent } from '../../src/core/event-bus.ts';

// Wait for THIS test's widget, not merely the next widget event on the bus.
//
// The unfiltered version was flaky under the full suite: fs.watch delivers on the
// platform's own schedule, so a debounce timer armed by an earlier test could
// still fire after that test returned. The waiter would resolve on that stale
// event, then the assertion for the widget this test wrote would find nothing.
// Filtering by chatId makes each waiter deaf to every other test's leftovers.
//
// The budget is generous on purpose: it bounds a hang, it does not measure
// latency. A shared CI box running the whole suite can delay a filesystem
// notification well past a second without anything being wrong.
const WAIT_MS = 10_000;

function onceWidgetEvent(chatId: string): Promise<BusEvent> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error(`timed out waiting for widget_updated (chatId=${chatId})`));
        }, WAIT_MS);
        const unsubscribe = subscribe(entry => {
            if (entry.event !== 'widget_updated') return;
            if (entry.data?.['chatId'] !== chatId) return;
            clearTimeout(timeout);
            unsubscribe();
            resolve(entry);
        });
    });
}

/** Wait for a widget event, rewriting the file until one arrives.
 *
 *  `fs.watch` gives no guarantee about when a newly attached watch starts
 *  observing: on macOS a write issued immediately after `startWidgetWatcher()`
 *  is routinely missed, which made a single write a coin flip and this file the
 *  suite's flakiest. Re-writing is safe because the production debounce collapses
 *  a burst into one event per widget — the same property the debounce test
 *  asserts — so retrying probes the watcher without changing what it emits. */
async function widgetEventAfterWrite(chatId: string, file: string, body: string): Promise<BusEvent> {
    const seen = onceWidgetEvent(chatId);
    const path = join(WIDGETS_DIR, chatId, file);
    let settled = false;
    void seen.then(() => { settled = true; }, () => { settled = true; });
    for (let attempt = 0; attempt < 20 && !settled; attempt++) {
        fs.writeFileSync(path, body);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return seen;
}

test('widget watcher broadcasts widget_updated for html files', async () => {
    const chatId = 'chat-a';
    fs.mkdirSync(join(WIDGETS_DIR, chatId), { recursive: true });
    const stop = startWidgetWatcher();
    try {
        const event = await widgetEventAfterWrite(chatId, 'chart.html', '<h1>one</h1>');
        assert.equal(event.topic, 'widget');
        // The scope rides along because the watcher fires from a filesystem timer,
        // outside any session's async context, so broadcast() cannot stamp it and a
        // scoped tab would otherwise never see its own widget update (072 §1.3a).
        assert.deepEqual(event.data, {
            chatId,
            widgetId: 'chart',
            scope: `local:${chatId}`,
            sessionId: chatId,
        });
    } finally {
        stop();
    }
});

test('widget watcher debounces rapid writes per chat/widget key', async () => {
    const chatId = 'chat-b';
    const widgetPath = join(WIDGETS_DIR, chatId, 'rapid.html');
    fs.mkdirSync(join(WIDGETS_DIR, chatId), { recursive: true });
    const events: BusEvent[] = [];
    const unsubscribe = subscribe(entry => {
        if (entry.event === 'widget_updated') events.push(entry);
    });
    const stop = startWidgetWatcher();
    try {
        // The burst is what is under test; the retry only guarantees the watcher
        // is actually observing before the burst is judged.
        const seen = onceWidgetEvent(chatId);
        let settled = false;
        void seen.then(() => { settled = true; }, () => { settled = true; });
        for (let attempt = 0; attempt < 20 && !settled; attempt++) {
            fs.writeFileSync(widgetPath, '<h1>one</h1>');
            fs.writeFileSync(widgetPath, '<h1>two</h1>');
            fs.writeFileSync(widgetPath, '<h1>three</h1>');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        await seen;
        // Debounce collapses the burst, but only once the window has closed —
        // waiting one more window proves no second event is still queued.
        await new Promise(resolve => setTimeout(resolve, 400));
        // One event per debounce window. A burst inside one window must not
        // produce one event per write — that is the property being protected.
        const perWindow = events.filter(e => e.data['chatId'] === chatId && e.data['widgetId'] === 'rapid');
        assert.ok(perWindow.length >= 1, 'the burst must produce at least one event');
        assert.ok(perWindow.length < 3, `debounce must collapse a 3-write burst, got ${perWindow.length}`);
    } finally {
        stop();
        unsubscribe();
    }
});

test('widget watcher stop is idempotent and detaches watchers', async () => {
    const chatId = 'chat-c';
    fs.mkdirSync(join(WIDGETS_DIR, chatId), { recursive: true });
    const events: BusEvent[] = [];
    const unsubscribe = subscribe(entry => {
        if (entry.event === 'widget_updated' && entry.data?.['chatId'] === chatId) events.push(entry);
    });
    const stop = startWidgetWatcher();
    stop();
    stop();
    fs.writeFileSync(join(WIDGETS_DIR, chatId, 'after-stop.html'), '<h1>stop</h1>');
    // Proving a NEGATIVE, so this wait cannot be replaced by an event: it has to
    // outlast the debounce window plus filesystem latency, or a silent watcher
    // and a merely slow one look identical.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    unsubscribe();
    assert.equal(events.length, 0);
});
