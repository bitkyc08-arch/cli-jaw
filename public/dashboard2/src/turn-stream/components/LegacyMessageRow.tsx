// 048 §4 — turn-less transcript rows: user prompts and legacy assistant
// messages (turn_id=null) render with their full text and empty segments.
import { type JSX } from 'react';
import type { LegacyMessageModel } from '../store/turn-store.ts';
import { MarkdownSegment } from './MarkdownSegment.tsx';

export function LegacyMessageRow({ message }: { message: LegacyMessageModel }): JSX.Element {
    const isUser = message.role === 'user';
    return (
        <article
            className={isUser ? 'd2-user-row' : 'd2-legacy-row'}
            data-msg-id={message.id}
            data-role={message.role}
        >
            {isUser ? (
                <div className="d2-user-bubble">{message.content}</div>
            ) : (
                <MarkdownSegment text={message.content} />
            )}
        </article>
    );
}
