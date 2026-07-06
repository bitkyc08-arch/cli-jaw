import assert from 'node:assert/strict';
import test from 'node:test';
import { extractRoutes, type RouteEntry } from '../../scripts/docs/extract-routes.mts';

const methodOrder = new Map(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((method, index) => [method, index]));

function compareRoutes(a: RouteEntry, b: RouteEntry): number {
    return a.path.localeCompare(b.path)
        || ((methodOrder.get(a.method) ?? 99) - (methodOrder.get(b.method) ?? 99))
        || a.method.localeCompare(b.method)
        || a.file.localeCompare(b.file)
        || a.line - b.line;
}

function hasRoute(routes: RouteEntry[], method: RouteEntry['method'], path: string): boolean {
    return routes.some(route => route.method === method && route.path === path);
}

test('extractRoutes returns stable-sorted core and manager route inventories', async () => {
    const inventory = await extractRoutes();
    for (const routes of [inventory.core.routes, inventory.manager.routes]) {
        assert.deepEqual(routes, [...routes].sort(compareRoutes));
    }
});

test('extractRoutes includes core sentinel routes and expected totals', async () => {
    const inventory = await extractRoutes();
    assert.equal(hasRoute(inventory.core.routes, 'POST', '/api/elicitation/callback'), true);
    assert.equal(hasRoute(inventory.core.routes, 'GET', '/api/events'), true);
    assert.equal(hasRoute(inventory.core.routes, 'POST', '/api/message'), true);
    assert.ok(inventory.core.total >= 230);
});

test('extractRoutes keeps manager route inventory separate', async () => {
    const inventory = await extractRoutes();
    assert.equal(
        hasRoute(inventory.manager.routes, 'POST', '/api/dashboard/instances/:port/project/pick'),
        true,
    );
});
