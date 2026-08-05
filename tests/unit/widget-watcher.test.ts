import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { startWidgetWatcher } from '../../src/core/widget-watcher.ts';
import { WIDGETS_DIR } from '../../src/core/config.ts';
import { subscribe, type BusEvent } from '../../src/core/event-bus.ts';

function onceWidgetEvent(): Promise<BusEvent> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error('timed out waiting for widget_updated'));
        }, 1500);
        const unsubscribe = subscribe(entry => {
            if (entry.event !== 'widget_updated') return;
            clearTimeout(timeout);
            unsubscribe();
            resolve(entry);
        });
    });
}

test('widget watcher broadcasts widget_updated for html files', async () => {
    const chatId = 'chat-a';
    fs.mkdirSync(join(WIDGETS_DIR, chatId), { recursive: true });
    const stop = startWidgetWatcher();
    try {
        const seen = onceWidgetEvent();
        fs.writeFileSync(join(WIDGETS_DIR, chatId, 'chart.html'), '<h1>one</h1>');
        const event = await seen;
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
        fs.writeFileSync(widgetPath, '<h1>one</h1>');
        fs.writeFileSync(widgetPath, '<h1>two</h1>');
        fs.writeFileSync(widgetPath, '<h1>three</h1>');
        await onceWidgetEvent();
        assert.equal(events.filter(e => e.data['chatId'] === chatId && e.data['widgetId'] === 'rapid').length, 1);
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
        if (entry.event === 'widget_updated') events.push(entry);
    });
    const stop = startWidgetWatcher();
    stop();
    stop();
    fs.writeFileSync(join(WIDGETS_DIR, chatId, 'after-stop.html'), '<h1>stop</h1>');
    await new Promise(resolve => setTimeout(resolve, 500));
    unsubscribe();
    assert.equal(events.length, 0);
});
