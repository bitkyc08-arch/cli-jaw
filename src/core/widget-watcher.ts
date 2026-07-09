import fs, { type FSWatcher } from 'node:fs';
import { join, parse } from 'node:path';
import { broadcast } from './bus.js';
import { WIDGETS_DIR } from './config.js';

const DEBOUNCE_MS = 300;
function warn(message: string, error: unknown): void {
    console.warn(`[widget-watcher] ${message}:`, (error as Error).message);
}
function isHtmlWidgetFile(name: string): boolean {
    return !name.startsWith('.') && name.endsWith('.html') && parse(name).name.length > 0;
}
export function removeWidgetDir(sessionId: string): void {
    try {
        fs.rmSync(join(WIDGETS_DIR, sessionId), { recursive: true, force: true });
    } catch (e) {
        warn(`failed to remove widget dir for session ${sessionId}`, e);
    }
}

export function startWidgetWatcher(): () => void {
    fs.mkdirSync(WIDGETS_DIR, { recursive: true });
    let stopped = false;
    let rootWatcher: FSWatcher | null = null;
    const chatWatchers = new Map<string, FSWatcher>();
    const timers = new Map<string, NodeJS.Timeout>();
    const clearTimer = (key: string) => {
        const timer = timers.get(key);
        if (timer) clearTimeout(timer);
        timers.delete(key);
    };
    const closeChatWatcher = (chatId: string) => {
        const watcher = chatWatchers.get(chatId);
        if (watcher) watcher.close();
        chatWatchers.delete(chatId);
        for (const key of [...timers.keys()]) {
            if (key.startsWith(`${chatId}/`)) clearTimer(key);
        }
    };
    const scheduleBroadcast = (chatId: string, filename: string) => {
        if (!isHtmlWidgetFile(filename)) return;
        const widgetId = parse(filename).name;
        const key = `${chatId}/${widgetId}`;
        clearTimer(key);
        timers.set(key, setTimeout(() => {
            timers.delete(key);
            if (!stopped) broadcast('widget_updated', { chatId, widgetId }, 'public');
        }, DEBOUNCE_MS));
    };
    const attachChatWatcher = (chatId: string) => {
        if (stopped || chatWatchers.has(chatId) || chatId.startsWith('.')) return;
        const chatDir = join(WIDGETS_DIR, chatId);
        try {
            if (!fs.statSync(chatDir).isDirectory()) return;
            const watcher = fs.watch(chatDir, (_event, filename) => {
                if (stopped) return;
                if (!fs.existsSync(chatDir)) {
                    closeChatWatcher(chatId);
                    return;
                }
                if (filename) scheduleBroadcast(chatId, filename.toString());
            });
            watcher.on('error', e => warn(`chat watcher error for ${chatId}`, e));
            chatWatchers.set(chatId, watcher);
        } catch (e) {
            if (!stopped && (e as NodeJS.ErrnoException).code !== 'ENOENT') warn(`failed to watch chat dir ${chatId}`, e);
        }
    };
    const syncChatWatcher = (chatId: string) => {
        const chatDir = join(WIDGETS_DIR, chatId);
        if (!fs.existsSync(chatDir)) {
            closeChatWatcher(chatId);
            return;
        }
        attachChatWatcher(chatId);
    };
    try {
        for (const entry of fs.readdirSync(WIDGETS_DIR, { withFileTypes: true })) {
            if (entry.isDirectory()) attachChatWatcher(entry.name);
        }
        rootWatcher = fs.watch(WIDGETS_DIR, (_event, filename) => {
            if (!stopped && filename) syncChatWatcher(filename.toString());
        });
        rootWatcher.on('error', e => warn('root watcher error', e));
    } catch (e) {
        warn('failed to start root watcher', e);
    }

    return () => {
        if (stopped) return;
        stopped = true;
        rootWatcher?.close();
        for (const watcher of chatWatchers.values()) watcher.close();
        chatWatchers.clear();
        for (const key of [...timers.keys()]) clearTimer(key);
    };
}
