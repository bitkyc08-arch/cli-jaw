// Telegram inline-keyboard rendering for single_select ```elicitation fences.
//
// Flow: pipeline.ts attaches raw specs to orchestrate_done (telegram origin only)
// → bot.ts calls startPendingElicitation and sends one message per question with an
// inline keyboard → bot.callbackQuery('elic:*') routes taps through
// handleElicitationCallback → when every question is answered, the combined answer
// is re-injected into tgOrchestrate as if the user typed it.
//
// Only fully single_select specs render as buttons; anything else falls back to the
// plain-text flattening pipeline.ts already applied to the message body.
import type { InlineKeyboardMarkup } from '@grammyjs/types';
import { parseElicitationSpec, type NormalizedSpec } from '../shared/elicitation-spec.js';

const PENDING_TTL_MS = 10 * 60_000;
const MAX_BUTTON_OPTIONS = 8;

export interface ElicitationKeyboardMessage {
    text: string;
    reply_markup: InlineKeyboardMarkup;
}

interface PendingElicitation {
    spec: NormalizedSpec;
    answers: Map<number, number>; // question index → option index
    createdAt: number;
}

const pendingByChat = new Map<string, PendingElicitation>();

export type ElicitationCallbackResult =
    | { kind: 'progress'; ack: string }
    | { kind: 'complete'; combinedAnswer: string; ack: string }
    | { kind: 'stale' };

/** True when every question is single_select with a small enough option set for buttons. */
export function isButtonRenderableSpec(spec: NormalizedSpec): boolean {
    return spec.questions.length > 0 && spec.questions.every(q =>
        q.type === 'single_select'
        && q.options.length > 0
        && q.options.length <= MAX_BUTTON_OPTIONS,
    );
}

/** One message per question; callback_data is index-based (`elic:<q>:<o>`, 64-byte safe). */
export function buildElicitationKeyboards(spec: NormalizedSpec): ElicitationKeyboardMessage[] {
    return spec.questions.map((question, qIdx) => ({
        text: spec.questions.length > 1 ? `Q${qIdx + 1}. ${question.question}` : question.question,
        reply_markup: {
            inline_keyboard: question.options.map((option, oIdx) => ([{
                text: option.label,
                callback_data: `elic:${qIdx}:${oIdx}`,
            }])),
        },
    }));
}

/** Parse + register a pending button session for the chat. Null → caller keeps plain fallback. */
export function startPendingElicitation(chatId: string, rawSpecJson: string): ElicitationKeyboardMessage[] | null {
    const spec = parseElicitationSpec(rawSpecJson);
    if (!spec || !isButtonRenderableSpec(spec)) return null;
    pendingByChat.set(chatId, { spec, answers: new Map(), createdAt: Date.now() });
    return buildElicitationKeyboards(spec);
}

export function handleElicitationCallback(chatId: string, callbackData: string): ElicitationCallbackResult {
    const pending = pendingByChat.get(chatId);
    if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
        pendingByChat.delete(chatId);
        return { kind: 'stale' };
    }
    const match = /^elic:(\d+):(\d+)$/.exec(callbackData);
    if (!match) return { kind: 'stale' };
    const qIdx = Number(match[1]);
    const oIdx = Number(match[2]);
    const question = pending.spec.questions[qIdx];
    const option = question?.options[oIdx];
    if (!question || !option) return { kind: 'stale' };

    pending.answers.set(qIdx, oIdx);
    if (pending.answers.size < pending.spec.questions.length) {
        return { kind: 'progress', ack: `${option.label} ✓` };
    }

    pendingByChat.delete(chatId);
    const combinedAnswer = pending.spec.questions.map((q, i) => {
        const chosen = q.options[pending.answers.get(i)!]!;
        return `${q.question}: ${chosen.label}`;
    }).join('\n');
    return { kind: 'complete', combinedAnswer, ack: `${option.label} ✓` };
}

/** Drop the pending session (user typed a reply instead of tapping, or a new turn started). */
export function discardPendingElicitation(chatId: string): void {
    pendingByChat.delete(chatId);
}

export function hasPendingElicitation(chatId: string): boolean {
    const pending = pendingByChat.get(chatId);
    if (!pending) return false;
    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
        pendingByChat.delete(chatId);
        return false;
    }
    return true;
}
