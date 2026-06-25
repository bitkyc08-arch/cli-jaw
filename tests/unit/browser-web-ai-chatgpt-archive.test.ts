import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveArchivePolicy,
    isTemporaryChatgptUrl,
    archiveConversation,
    type ArchivePage,
} from '../../src/browser/web-ai/chatgpt-archive.ts';

const COMPLETE = { conversationUrl: 'https://chatgpt.com/c/abc', status: 'complete' };

// 102 chatgpt-archive: auto-archive policy gating.
test('BWAI-ARCHIVE-001: --archive never short-circuits before any other check', () => {
    assert.deepEqual(
        resolveArchivePolicy({ archiveFlag: 'never', session: COMPLETE }),
        { shouldArchive: false, reason: 'archive-disabled' },
    );
});

test('BWAI-ARCHIVE-002: no conversation url → no archive', () => {
    assert.equal(resolveArchivePolicy({ session: {} }).reason, 'no-conversation-url');
});

test('BWAI-ARCHIVE-003: temporary chat (either url) → no archive', () => {
    assert.equal(
        resolveArchivePolicy({ session: { conversationUrl: 'https://chatgpt.com/?temporary-chat=true' } }).reason,
        'temporary-chat',
    );
    assert.equal(
        resolveArchivePolicy({ session: { conversationUrl: 'https://chatgpt.com/c/x', originalUrl: 'https://chatgpt.com/?temporary-chat=TRUE' } }).reason,
        'temporary-chat',
    );
});

test('BWAI-ARCHIVE-004: required artifact save failed → no archive', () => {
    assert.equal(
        resolveArchivePolicy({ session: COMPLETE, artifactStatus: { required: true, ok: false } }).reason,
        'artifact-save-failed',
    );
});

test('BWAI-ARCHIVE-005: --archive always forces archive (past artifact ok, past one-shot gates)', () => {
    assert.deepEqual(
        resolveArchivePolicy({ archiveFlag: 'always', session: { conversationUrl: 'https://chatgpt.com/c/x', status: 'timeout', followUpCount: 3 } }),
        { shouldArchive: true, reason: 'archive-forced' },
    );
});

test('BWAI-ARCHIVE-006: auto gates — multi-turn / deep-research / project / not-completed', () => {
    assert.equal(resolveArchivePolicy({ session: { ...COMPLETE, followUpCount: 1 } }).reason, 'multi-turn-session');
    assert.equal(resolveArchivePolicy({ session: { ...COMPLETE, researchMode: 'deep' } }).reason, 'deep-research-session');
    assert.equal(resolveArchivePolicy({ session: { ...COMPLETE, projectUrl: 'https://chatgpt.com/g/p1' } }).reason, 'project-chat');
    assert.equal(resolveArchivePolicy({ session: { conversationUrl: 'https://chatgpt.com/c/x', status: 'streaming' } }).reason, 'session-not-completed');
});

test('BWAI-ARCHIVE-007: clean one-shot complete chat → archive', () => {
    assert.deepEqual(
        resolveArchivePolicy({ session: COMPLETE }),
        { shouldArchive: true, reason: 'auto-archive-one-shot' },
    );
    // "completed" status spelling also accepted
    assert.equal(resolveArchivePolicy({ session: { conversationUrl: 'https://chatgpt.com/c/x', status: 'completed' } }).shouldArchive, true);
});

test('BWAI-ARCHIVE-008: isTemporaryChatgptUrl', () => {
    assert.equal(isTemporaryChatgptUrl('https://chatgpt.com/?temporary-chat=true'), true);
    assert.equal(isTemporaryChatgptUrl('https://chatgpt.com/?temporary-chat=false'), false);
    assert.equal(isTemporaryChatgptUrl('https://chatgpt.com/c/abc'), false);
    assert.equal(isTemporaryChatgptUrl(null), false);
    assert.equal(isTemporaryChatgptUrl('not a url'), false);
});

test('BWAI-ARCHIVE-009: archiveConversation bails on url mismatch', async () => {
    const page: ArchivePage = {
        url: () => 'https://chatgpt.com/c/different',
        locator: () => ({ first: () => ({ async isVisible() { return false; }, async click() {} }) }),
        async waitForTimeout() {},
        keyboard: { async press() {} },
    };
    assert.deepEqual(await archiveConversation(page, { conversationUrl: 'https://chatgpt.com/c/abc' }), {
        ok: false,
        warning: 'conversation-url-mismatch',
    });
});

test('BWAI-ARCHIVE-010: archiveConversation clicks trigger then Archive item', async () => {
    const clicks: string[] = [];
    const page: ArchivePage = {
        url: () => 'https://chatgpt.com/c/abc',
        locator: (sel: string) => ({
            first: () => ({
                async isVisible() { return sel.includes('conversation-menu-trigger') || sel.includes('Archive'); },
                async click() { clicks.push(sel); },
            }),
        }),
        async waitForTimeout() {},
        keyboard: { async press() { clicks.push('escape'); } },
    };
    const r = await archiveConversation(page, { conversationUrl: 'https://chatgpt.com/c/abc' });
    assert.deepEqual(r, { ok: true });
    assert.equal(clicks[0], 'button[data-testid="conversation-menu-trigger"]');
    assert.ok(clicks.some((c) => c.includes('Archive')));
    assert.ok(!clicks.includes('escape'));
});
