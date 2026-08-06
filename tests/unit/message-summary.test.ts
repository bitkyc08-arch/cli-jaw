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

test('dashboard activity title removes image and video upload prefixes', () => {
    // 회귀 근거: 이미지/동영상 변형을 모르면 업로드 절대경로가 그대로 제목이 된다
    // (devlog 260806_slack_multifile_ingest/010 D-5).
    assert.equal(
        cleanDashboardActivityTitle([
            '[사용자가 이미지를 보냈습니다: /Users/jun/.cli-jaw/uploads/x_Screenshot.png]',
            '이 이미지를 분석해주세요.',
            '',
            '사용자 메시지: 이 화면 왜 이래',
        ].join('\n')),
        '이 이미지를 분석해주세요.',
    );
    assert.equal(
        cleanDashboardActivityTitle([
            '[사용자가 동영상을 보냈습니다: /Users/jun/.cli-jaw/uploads/x_clip.mp4]',
            '사용자 메시지: 여기 버벅임 보이지',
        ].join('\n')),
        '여기 버벅임 보이지',
    );
});

test('dashboard activity title skips multi-file header and numbered entries', () => {
    assert.equal(
        cleanDashboardActivityTitle([
            '[사용자가 파일 2개를 보냈습니다]',
            '1. [이미지] /Users/jun/.cli-jaw/uploads/a.png',
            '2. [이미지] /Users/jun/.cli-jaw/uploads/b.png',
            '',
            '사용자 메시지: 두 화면 비교해줘',
        ].join('\n')),
        '두 화면 비교해줘',
    );
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
