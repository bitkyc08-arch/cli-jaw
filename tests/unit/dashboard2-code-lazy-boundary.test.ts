import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { dispatchSelectedSyncPayload } from '../../public/dashboard2/src/providers/sync-provider.tsx';

const dashboardRoot = new URL('../../public/dashboard2/src/', import.meta.url);

function source(path: string): string {
    return readFileSync(new URL(path, dashboardRoot), 'utf8');
}

function dashboardSources(directory = dashboardRoot.pathname): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        const repoPath = relative(dashboardRoot.pathname, absolute);
        if (entry.isDirectory()) {
            if (repoPath === 'code') continue;
            files.push(...dashboardSources(absolute));
        } else if (/\.(?:ts|tsx)$/.test(entry.name)
            && repoPath !== 'providers/sync-provider.tsx'
            && repoPath !== 'shell/Sidebar.tsx') {
            files.push(absolute);
        }
    }
    return files;
}

test('060 lazy boundary keeps Code symbols inside code/ except the transport owner', () => {
    const forbidden = /jwc|code_(agent|tool|turn|user|session)|code-source-adapter|code-event-types|code-api-client/;
    const violations = dashboardSources().flatMap(path => {
        const match = readFileSync(path, 'utf8').match(forbidden);
        return match ? [`${relative(dashboardRoot.pathname, path)}: ${match[0]}`] : [];
    });
    assert.deepEqual(violations, []);

    const sidebar = source('shell/Sidebar.tsx');
    assert.doesNotMatch(
        sidebar,
        /code-source-adapter|code-event-types|code-api-client|code_(agent|tool|turn|user|session)|from\s+['"]\.\.\/code/,
    );

    const sidePane = source('shell/SidePane.tsx');
    assert.ok(sidePane.includes("import('../code/index.ts')"));
    assert.doesNotMatch(sidePane, /^import(?:[\s\S]*?)\sfrom\s+['"]\.\.\/code/m);
});

test('060 sync dispatch preserves the jwc envelope and isolates other dispatch lanes', () => {
    const calls = { turn: 0, body: 0, queue: 0, system: 0, jwc: 0 };
    let received: Record<string, unknown> | null = null;
    const dispatchers = {
        turn: () => { calls.turn += 1; },
        body: () => { calls.body += 1; },
        queue: () => { calls.queue += 1; },
        system: () => { calls.system += 1; },
        jwc: (payload: Record<string, unknown>) => { calls.jwc += 1; received = payload; },
    };
    dispatchSelectedSyncPayload({
        topic: 'jwc', event: 'code_agent_message_chunk', sessionId: 's',
    }, dispatchers, '7');
    assert.equal(calls.jwc, 1);
    assert.equal(received?.['sseEventId'], '7');
    assert.deepEqual({ turn: calls.turn, body: calls.body, queue: calls.queue }, {
        turn: 0, body: 0, queue: 0,
    });

    dispatchSelectedSyncPayload({ topic: 'queue', event: 'queue_update' }, dispatchers);
    assert.equal(calls.queue, 1);
    assert.doesNotThrow(() => dispatchSelectedSyncPayload({
        topic: 'jwc', event: 'code_turn_done', sessionId: 's',
    }, { ...dispatchers, jwc: undefined }));
});

test('060 sync provider exposes subscribeJwc on ManagerSyncContextValue', () => {
    const syncProvider = source('providers/sync-provider.tsx');
    assert.match(syncProvider, /interface ManagerSyncContextValue[\s\S]*?subscribeJwc\s*\(/);
});
