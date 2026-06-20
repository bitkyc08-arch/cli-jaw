import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolContentFromUpdate } from '../../public/manager/src/code/code-types.ts';
import { replayEventsToTranscriptEntries } from '../../public/manager/src/code/code-transcript-replay.ts';

test('code tool rawOutput extracts JWC text content instead of rendering raw JSON payload', () => {
    const content = normalizeToolContentFromUpdate({
        rawOutput: {
            content: [
                { type: 'text', text: '.\n - codex-shim.ts 6.7KB\n - server.ts 29.8KB' },
            ],
        },
    });

    assert.equal(content.length, 1);
    assert.equal(content[0]?.type, 'output');
    assert.equal(content[0]?.label, 'Output');
    assert.equal(content[0]?.text, '.\n - codex-shim.ts 6.7KB\n - server.ts 29.8KB');
    assert.equal(content[0]?.text?.includes('"content"'), false);
});

test('code replay keeps rawOutput in normalized toolContent only, avoiding duplicate toolOutput rendering', () => {
    const entries = replayEventsToTranscriptEntries([
        {
            event: 'code_tool_call',
            sessionId: 's1',
            update: { toolCallId: 'tool-1', title: 'read: src/server.ts', status: 'running' },
        },
        {
            event: 'code_tool_call_update',
            sessionId: 's1',
            update: {
                toolCallId: 'tool-1',
                status: 'completed',
                rawOutput: {
                    content: [
                        { type: 'text', text: 'read result text' },
                    ],
                },
            },
        },
    ]);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.role, 'tool');
    assert.equal(entries[0]?.toolOutput, undefined);
    assert.equal(entries[0]?.toolContent?.length, 1);
    assert.equal(entries[0]?.toolContent?.[0]?.type, 'output');
    assert.equal(entries[0]?.toolContent?.[0]?.text, 'read result text');
});
