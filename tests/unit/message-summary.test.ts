import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cleanDashboardActivityTitle,
    dashboardActivityTitleFromExcerpt,
} from '../../src/core/message-summary.js';

test('dashboard activity title removes upload and user-message prefixes', () => {
    const title = cleanDashboardActivityTitle([
        '[사용자가 파일을 보냈습니다: /tmp/screenshot.png]',
        '사용자 메시지: active model name should update in the sidebar',
    ].join('\n'));

    assert.equal(title, 'active model name should update in the sidebar');
});

test('dashboard activity title strips simple markdown wrappers', () => {
    assert.equal(
        cleanDashboardActivityTitle('## **Fix dashboard preview refresh**'),
        'Fix dashboard preview refresh',
    );
    assert.equal(
        cleanDashboardActivityTitle('> [Open issue](https://example.com)'),
        'Open issue',
    );
});

test('dashboard activity title clamps long excerpts without exposing full content', () => {
    const title = cleanDashboardActivityTitle('a'.repeat(120));

    assert.equal(title.length, 64);
    assert.ok(title.endsWith('…'));
});

test('dashboard activity title returns null for empty excerpts', () => {
    assert.equal(dashboardActivityTitleFromExcerpt(null), null);
    assert.equal(dashboardActivityTitleFromExcerpt('```'), null);
});
