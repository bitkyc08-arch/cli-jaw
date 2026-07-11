import { useEffect } from 'react';
import { isAllowedPreviewMessage } from '../preview-message-security';
import { publishInvalidation, type InvalidationTopic } from './invalidation-bus';

const VALID_TOPICS = new Set<InvalidationTopic>(['notes', 'instances']);

type IframeInvalidationMessage = {
    type: 'dashboard.invalidate';
    topics: InvalidationTopic[];
    reason: string;
};

function isValid(data: unknown): data is IframeInvalidationMessage {
    const d = data as Partial<IframeInvalidationMessage>;
    return d?.type === 'dashboard.invalidate'
        && Array.isArray(d.topics)
        && d.topics.every(t => VALID_TOPICS.has(t as InvalidationTopic));
}

export function IframeBridge(props: { allowedOrigins: ReadonlySet<string> }): null {
    useEffect(() => {
        function onMessage(event: MessageEvent): void {
            if (!isAllowedPreviewMessage(event, props.allowedOrigins)) return;
            if (!isValid(event.data)) return;
            publishInvalidation({ ...event.data, source: 'iframe' });
        }
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [props.allowedOrigins]);
    return null;
}
