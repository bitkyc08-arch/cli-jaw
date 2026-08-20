// ─── The one line a reader gets when a turn was cut short ───
//
// Its own leaf module because both ends of the system need it and neither should
// pull in the other: `lifecycle-handler` appends it, and `core/db` strips it
// back off at the query boundary so nothing that reads history as INSTRUCTIONS
// sees a sentence addressed to a person (#405).

export const STALL_TRUNCATION_NOTICE =
    '⏱️ 시간이 초과되어 여기서 중단했습니다. 범위를 좁혀 다시 요청해 주세요.';

/**
 * Remove the notice this system appended, and nothing else.
 *
 * Suffix-anchored on purpose: deleting every occurrence ate the sentence out of
 * a plan that legitimately quoted it, and a bare `trimEnd()` took meaningful
 * Markdown trailing spaces with it.
 */
export function stripStallTruncationNotice(text: string): string {
    const appended = `\n\n${STALL_TRUNCATION_NOTICE}`;
    return text.endsWith(appended) ? text.slice(0, -appended.length) : text;
}
