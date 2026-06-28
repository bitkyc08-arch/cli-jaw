import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyAgyTranscriptMode,
    formatAgyWatchdogContext,
} from '../../src/agent/agy-runtime.ts';

test('AGY-TM-001: accepted bootstrap plus transcript activity is anchored', () => {
    assert.equal(classifyAgyTranscriptMode({
        agyTranscriptActive: true,
        agyBootstrapAcceptanceMode: 'accepted',
        fullText: 'final',
        liveOutputText: 'final',
    }), 'anchored');
});

test('AGY-TM-002: transcript activity without required bootstrap remains anchored for compatibility', () => {
    assert.equal(classifyAgyTranscriptMode({
        agyTranscriptActive: true,
        agyBootstrapAcceptanceMode: 'not-applicable',
        fullText: 'final',
        liveOutputText: 'final',
    }), 'anchored');
});

test('AGY-TM-003: transcript activity with missing or pending bootstrap is bootstrap-missing', () => {
    assert.equal(classifyAgyTranscriptMode({
        agyTranscriptActive: true,
        agyBootstrapAcceptanceMode: 'missing',
        fullText: 'final',
        liveOutputText: 'final',
    }), 'bootstrap-missing');
    assert.equal(classifyAgyTranscriptMode({
        agyTranscriptActive: true,
        agyBootstrapAcceptanceMode: 'pending',
        fullText: 'final',
        liveOutputText: 'final',
    }), 'bootstrap-missing');
});

test('AGY-TM-004: provider error wins over other transcript modes', () => {
    assert.equal(classifyAgyTranscriptMode({
        agyTranscriptActive: true,
        agyBootstrapAcceptanceMode: 'accepted',
        agyLastTranscriptError: { message: 'unavailable', code: 503 },
        fullText: 'final',
        liveOutputText: 'final',
    }), 'provider-error');
});

test('AGY-TM-005: stdout-only fallback and timeout fallback are explicit', () => {
    assert.equal(classifyAgyTranscriptMode({
        fullText: 'answer without transcript',
        liveOutputText: 'answer without transcript',
    }), 'fallback-missing');
    assert.equal(classifyAgyTranscriptMode({
        fullText: 'partial\nError: timed out waiting for response',
        liveOutputText: 'partial\nError: timed out waiting for response',
    }), 'fallback-timeout');
    assert.equal(classifyAgyTranscriptMode({
        fullText: '',
        liveOutputText: '',
    }), 'not-started');
});

test('AGY-TM-006: watchdog context is bounded and does not leak raw prompt-like content', () => {
    const context = formatAgyWatchdogContext({
        stallReason: 'idle timeout',
        agyTranscriptMode: 'bootstrap-missing',
        agyTranscriptLastReason: 'transcript-selected',
        agyLastActivitySource: 'transcript',
        sessionId: 'sess-123',
        toolLog: [
            { icon: 'x', label: '[Current cli-jaw task]\nSECRET_PROMPT_PAYLOAD'.repeat(20), toolType: 'tool', status: 'running' },
        ],
    });
    assert.match(context, /\[AGY interrupted by watchdog\]/);
    assert.match(context, /reason=idle timeout/);
    assert.match(context, /transcriptMode=bootstrap-missing/);
    assert.match(context, /lastActivity=transcript/);
    assert.match(context, /sessionId=sess-123/);
    assert.match(context, /lastTool=/);
    assert.ok(context.length < 700);
    assert.doesNotMatch(context, /SECRET_PROMPT_PAYLOAD.*SECRET_PROMPT_PAYLOAD/s);
});
