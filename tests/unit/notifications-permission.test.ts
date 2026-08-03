// Permission is asked once, from a gesture, and a denial is never re-asked.
// A prompt on page load is the fastest way to earn a permanent block.
import test from 'node:test';
import assert from 'node:assert/strict';

type Store = Record<string, string>;

function install(permission: NotificationPermission, store: Store, requestResult: NotificationPermission = 'granted') {
    const asks: number[] = [];
    (globalThis as Record<string, unknown>)['localStorage'] = {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = v; },
    };
    (globalThis as Record<string, unknown>)['Notification'] = {
        permission,
        requestPermission: async () => { asks.push(1); return requestResult; },
    };
    return asks;
}

async function freshModule() {
    // Cache-bust so each case sees a clean module.
    return await import(`../../public/js/features/notifications.ts?case=${Math.random()}`);
}

test('asks once on the first gesture and remembers it', async () => {
    const store: Store = {};
    const asks = install('default', store);
    const mod = await freshModule();

    assert.equal(await mod.maybeRequestNotificationPermission(), 'granted');
    assert.equal(asks.length, 1);
    assert.equal(store['jaw:notificationsAsked'], '1', 'the ask must be remembered');

    // Second call in the same browser: no second prompt.
    assert.equal(await mod.maybeRequestNotificationPermission(), null);
    assert.equal(asks.length, 1);
});

test('a denial is never re-asked', async () => {
    const store: Store = { 'jaw:notificationsAsked': '1' };
    const asks = install('default', store, 'denied');
    const mod = await freshModule();

    assert.equal(await mod.maybeRequestNotificationPermission(), null);
    assert.equal(asks.length, 0, 'a remembered ask must not prompt again');
});

test('an already-decided permission short-circuits without prompting', async () => {
    const store: Store = {};
    const asks = install('granted', store);
    const mod = await freshModule();

    assert.equal(await mod.maybeRequestNotificationPermission(), 'granted');
    assert.equal(asks.length, 0);
    assert.equal(store['jaw:notificationsAsked'], undefined, 'nothing to remember when nothing was asked');
});

test('an environment without Notification is a no-op', async () => {
    const store: Store = {};
    install('default', store);
    delete (globalThis as Record<string, unknown>)['Notification'];
    const mod = await freshModule();
    assert.equal(await mod.maybeRequestNotificationPermission(), null);
});
