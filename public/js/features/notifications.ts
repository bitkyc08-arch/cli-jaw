// ── Browser notification permission ──
// Asked ONCE, and only from a real user gesture. Browsers reject unprompted
// requests, and a permission prompt on page load is the fastest way to earn a
// permanent "block" — so the ask rides the wizard's save step, where the user
// just connected a channel and inbound messages are about to arrive.

const ASKED_KEY = 'jaw:notificationsAsked';

export function notificationsAsked(): boolean {
    try {
        return localStorage.getItem(ASKED_KEY) === '1';
    } catch {
        // Private mode / disabled storage: treat as asked so a blocked write
        // cannot turn into a prompt on every save.
        return true;
    }
}

function markAsked(): void {
    try { localStorage.setItem(ASKED_KEY, '1'); } catch { /* best-effort */ }
}

/**
 * Request notification permission if it has never been asked in this browser.
 * Returns the resulting permission, or null when nothing was asked.
 * A denial is remembered too: never nag.
 */
export async function maybeRequestNotificationPermission(): Promise<NotificationPermission | null> {
    if (typeof Notification === 'undefined') return null;
    if (Notification.permission !== 'default') return Notification.permission;
    if (notificationsAsked()) return null;
    markAsked();
    try {
        return await Notification.requestPermission();
    } catch {
        return null;
    }
}
