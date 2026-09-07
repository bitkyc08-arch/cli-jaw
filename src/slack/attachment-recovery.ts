// ─── Slack Attachment Recovery ───────────────────────
// app_mention 봉투에는 files 가 없다 — 문서화된 스키마에 부재하며, Slack은
// 첨부가 필요하면 channel+ts 로 대화를 다시 조회하라고 안내한다.
// https://docs.slack.dev/reference/events/app_mention/
//
// 같은 업로드의 message 사본은 events.ts 의 mention_via_app_mention 가
// 드롭한다(한 멘션이 두 에이전트 실행이 되는 것을 막는 의도적 동작). 그래서
// 멘션과 함께 올린 첨부는 어느 봉투로도 도달하지 못한다. 드롭을 되돌리는 대신
// 첨부만 되찾는다.

import { fetchSlackHistory, fetchSlackReplies } from './history.js';
import type { SlackFileEvent } from './events.js';
import type { SlackFetch } from './api.js';

export type RecoverAttachmentOptions = {
    threadTs?: string;
    fetchImpl?: SlackFetch;
};

/** 스레드 조회 상한. 한 스레드에서 대상 ts 를 찾기에 충분하다. */
const THREAD_LOOKUP_LIMIT = 50;

/**
 * (channel, ts) 메시지의 첨부를 되찾는다. 스레드 안이면 replies, 아니면
 * history 를 쓴다.
 *
 * 실패는 예외가 아니라 빈 배열이다: 첨부 복구는 보조 경로이고, 여기서 던지면
 * 텍스트만 있는 평범한 멘션까지 처리가 중단된다.
 */
export async function recoverSlackAttachments(
    token: string,
    channel: string,
    ts: string,
    options: RecoverAttachmentOptions = {},
): Promise<SlackFileEvent[]> {
    if (!token || !channel || !ts) return [];
    const fetchOpts = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
    try {
        const result = options.threadTs
            ? await fetchSlackReplies(token, channel, options.threadTs, {
                limit: THREAD_LOOKUP_LIMIT, ...fetchOpts,
            })
            // oldest 는 배타적이므로 inclusive 없이는 대상 메시지가 빠진다.
            : await fetchSlackHistory(token, channel, {
                oldest: ts, inclusive: true, limit: 1, ...fetchOpts,
            });
        if (!result.ok) return [];
        const match = result.messages.find(message => message.ts === ts);
        return match?.files ?? [];
    } catch {
        return [];
    }
}
