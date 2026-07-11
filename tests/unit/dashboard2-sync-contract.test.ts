import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readSource(join(projectRoot, path), 'utf8');
}

test('dashboard2 sync provider consumes the proxied data-only turn stream', () => {
    const provider = read('public/dashboard2/src/providers/sync-provider.tsx');

    assert.ok(provider.includes('new EventSource(`/i/${selectedPort}/api/events${suffix}`)'),
        'selected instance SSE must use the /i/ proxy and /api/events');
    for (const event of ['turn_start', 'turn_segment', 'turn_end', 'replay_gap', 'turn_segment_error']) {
        assert.ok(provider.includes(`'${event}'`), `sync provider must dispatch ${event}`);
    }
    assert.match(provider,
        /import\s+type\s+\{\s*TurnLifecycleSsePayload\s*\}\s+from\s+['"][^'"]*src\/shared\/chat-events\.ts['"];/,
        'TurnLifecycleSsePayload must be consumed through a type-only import');
    assert.doesNotMatch(provider,
        /import\s+(?!type\b)[^;]*TurnLifecycleSsePayload[^;]*from/,
        'TurnLifecycleSsePayload must not be imported at runtime');
    assert.ok(provider.includes('generationRef'), 'sync provider must guard EventSource generations');
    assert.ok(provider.includes('generation !== generationRef.current'),
        'late events from an old generation must be ignored');
});

test('dashboard2 API provider separates manager and instance contracts', () => {
    const provider = read('public/dashboard2/src/providers/api-provider.tsx');

    assert.ok(provider.includes("new URLSearchParams('includeSegments=1')"),
        'messages paging must request segmented rows');
    assert.ok(provider.includes('`/i/${port}/api/messages?${params.toString()}`'),
        'messages paging must use the selected instance proxy');
    assert.match(provider,
        /import\s+type\s+\{\s*MessagesPageResponse\s*\}\s+from\s+['"][^'"]*src\/shared\/chat-events\.ts['"];/,
        'MessagesPageResponse must be consumed through a type-only import');
    assert.ok(provider.includes("method: 'PATCH'"), 'registry updates must use PATCH');
    assert.ok(provider.includes("'/api/dashboard/registry'"),
        'registry calls must stay on the manager origin');
});

test('legacy ChatSsePayload deliberately excludes turn lifecycle events', () => {
    const shared = read('src/shared/chat-events.ts');
    const unionStart = shared.indexOf('export type ChatSsePayload =');
    assert.ok(unionStart >= 0, 'ChatSsePayload union must exist');
    const union = shared.slice(unionStart, shared.indexOf(';', unionStart) + 1);

    assert.ok(!union.includes('TurnLifecycleSsePayload'),
        'legacy ChatSsePayload must not absorb the dashboard2 turn lifecycle contract');
    assert.ok(!union.includes('turn_start'), 'legacy ChatSsePayload union must exclude turn_start');
});
