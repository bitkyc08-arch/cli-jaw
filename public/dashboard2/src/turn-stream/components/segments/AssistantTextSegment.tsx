import type { JSX } from 'react';

export interface AssistantTextSegmentProps {
    text: string;
}

export function AssistantTextSegment({ text }: AssistantTextSegmentProps): JSX.Element | null {
    if (!text) return null;
    return <div className="d2-assistant-text">{text}</div>;
}
