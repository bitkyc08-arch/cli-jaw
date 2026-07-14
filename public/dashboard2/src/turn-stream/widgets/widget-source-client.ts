export type WidgetSourceErrorCode = 'invalid-descriptor' | 'decode' | 'http' | 'cancelled';

export class WidgetSourceError extends Error {
    constructor(readonly code: WidgetSourceErrorCode, message: string, readonly status?: number) {
        super(message);
        this.name = 'WidgetSourceError';
    }
}

export interface WidgetSourceRequest {
    chatId: string;
    storage: 'inline' | 'file';
    source?: string;
    widgetId?: string;
    revision: string;
}

export interface WidgetSourceResult { source: string; revision: string; generation: number }

function decodeInline(encoded: string): string {
    try {
        const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/');
        const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), char => char.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        throw new WidgetSourceError('decode', 'Invalid inline widget source');
    }
}

export function createWidgetSourceClient(fetchImpl: typeof fetch = fetch): {
    load(request: WidgetSourceRequest): Promise<WidgetSourceResult>;
    cancel(): void;
    generation(): number;
} {
    let currentGeneration = 0;
    let controller: AbortController | null = null;
    return {
        async load(request) {
            controller?.abort();
            controller = new AbortController();
            const requestController = controller;
            const generation = ++currentGeneration;
            try {
                if (request.storage === 'inline') {
                    if (!request.source) throw new WidgetSourceError('invalid-descriptor', 'Inline widget source is missing');
                    return { source: decodeInline(request.source), revision: request.revision, generation };
                }
                if (!request.chatId || !request.widgetId) throw new WidgetSourceError('invalid-descriptor', 'File widget identity is missing');
                const url = `/api/widgets/${encodeURIComponent(request.chatId)}/${encodeURIComponent(request.widgetId)}`;
                const response = await fetchImpl(url, { credentials: 'same-origin', signal: requestController.signal });
                if (!response.ok) throw new WidgetSourceError('http', `Widget source request failed (${response.status})`, response.status);
                return { source: await response.text(), revision: request.revision, generation };
            } catch (error) {
                if (requestController.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
                    throw new WidgetSourceError('cancelled', 'Widget source request cancelled');
                }
                throw error;
            }
        },
        cancel() { controller?.abort(); controller = null; currentGeneration += 1; },
        generation: () => currentGeneration,
    };
}
