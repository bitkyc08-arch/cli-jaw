// A runtime failure the user can act on, rendered once for every channel.
//
// Before this module, `agent_done` payloads carrying `error: true` were dropped
// by a single clause in each forwarder, so a 429 or an expired login reached the
// user only as whatever prose the model had produced before it died — usually an
// apology with no cause (#519). The fix is not "stop dropping": most error
// broadcasts carry raw exception text, a slice of the model's own output, or an
// internal employee diagnostic, and posting those verbatim would trade silence
// for leakage.
//
// So delivery is OPT-IN. A payload is rendered only when the classifier tagged it
// with a known `errorKind`, which is true at exactly the sites that already build
// a user-facing message. Everything else stays out of the channel and stays in
// the trace, where it was already going.

/** What went wrong, in terms the next action depends on. */
export type ErrorKind = 'rate_limit' | 'auth' | 'stall' | 'connection' | 'exit';

/** Whether this payload is a classified failure meant for a human in a channel. */
export function isRenderableError(data: Record<string, unknown>): boolean {
    if (data['error'] !== true) return false;
    // An internal-audience payload is a diagnostic for the operator surface.
    // `broadcast(..., 'internal')` suppresses only the SSE publish (core/bus.ts),
    // not the forwarder listeners, so the audience check has to happen here or an
    // employee-lane error posts into the user's conversation.
    if (data['audience'] === 'internal' || data['isEmployee'] === true) return false;
    return isErrorKind(data['errorKind']);
}

export function isErrorKind(value: unknown): value is ErrorKind {
    return value === 'rate_limit' || value === 'auth' || value === 'stall'
        || value === 'connection' || value === 'exit';
}

/** What the user can do about it — the half the old prose never supplied. */
const ACTION: Record<ErrorKind, string> = {
    rate_limit: '잠시 후 자동으로 재시도합니다. 폴백 런타임이 설정돼 있으면 그쪽으로 넘어갑니다.',
    auth: '해당 CLI의 로그인 상태를 확인해주세요. 재시도해도 같은 오류가 납니다.',
    stall: '런타임이 응답을 멈췄습니다. 같은 요청을 다시 보내면 새 세션에서 시작합니다.',
    connection: '연결이 끊겼습니다. 자동으로 재시도합니다.',
    exit: '런타임이 비정상 종료했습니다. 반복되면 로그를 확인해주세요.',
};

/** Render the block a channel actually posts.
 *
 *  Deliberately built from the CLASSIFIED fields only. The raw stderr that
 *  produced the classification stays in the trace: it is unbounded, frequently
 *  contains paths and tokens, and the user cannot act on it. */
export function renderAgentErrorBlock(data: Record<string, unknown>): string | null {
    if (!isRenderableError(data)) return null;
    const kind = data['errorKind'] as ErrorKind;
    const text = typeof data['text'] === 'string' ? data['text'].trim() : '';
    const cli = typeof data['cli'] === 'string' ? data['cli'] : '';
    const header = text || '❌ 런타임 오류';
    const where = cli ? ` (${cli})` : '';
    return `${header}${where}\n↳ ${ACTION[kind]}`;
}
