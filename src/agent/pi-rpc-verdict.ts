export type PiRpcVerdict = 'supported' | 'proven-unsupported' | 'inconclusive';

export type PiRpcVerdictRecord = {
    id?: number;
    type?: string;
    command?: string;
    success?: boolean;
    error?: { message?: string };
    done?: boolean;
    text?: string;
    userEcho?: string;
};

const PROTOCOL_REJECTION_RE = /unknown (type|message|command)|invalid state|not (running|ready)|unsupported (message|type|command)|unexpected message/i;

export function classifySecondPromptOutcome(input: {
    records: PiRpcVerdictRecord[];
    secondPromptId: number;
    timedOut: boolean;
    selfExited: boolean;
    firstPromptSucceeded: boolean;
}): PiRpcVerdict {
    if (!input.firstPromptSucceeded) return 'inconclusive';
    if (input.selfExited) return 'proven-unsupported';
    // 모델 비결정성 강건 (2026-08-02 실probe): 두 번째 턴 답변이 reasoning 채널로만 나가
    // text 파트가 빈 경우가 있다. 프로토콜 사실을 증거로 — (a) id 상관 success 수락,
    // (b) 이후 done이며 user echo 또는 assistant text가 SECOND 포함.
    const secondAccepted = input.records.some((record) =>
        record.id === input.secondPromptId && record.type === 'response' && record.command === 'prompt' && record.success === true);
    const secondCompleted = input.records.some((record) =>
        record.done && ((typeof record.text === 'string' && record.text.includes('SECOND'))
            || (typeof record.userEcho === 'string' && record.userEcho.includes('SECOND'))));
    if (secondAccepted && secondCompleted) {
        return 'supported';
    }
    const correlatedError = input.records.find((record) => record.id === input.secondPromptId && record.error);
    if (correlatedError && PROTOCOL_REJECTION_RE.test(correlatedError.error?.message || '')) {
        return 'proven-unsupported';
    }
    return 'inconclusive';
}
