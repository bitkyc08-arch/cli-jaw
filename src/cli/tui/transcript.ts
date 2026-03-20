export type TranscriptItem =
    | { type: 'user'; displayText: string; submitText: string; timestamp: number }
    | { type: 'assistant'; text: string; streaming: boolean; timestamp: number }
    | { type: 'status'; text: string; ephemeral: true; timestamp: number };

export interface TranscriptState {
    items: TranscriptItem[];
}

export function createTranscriptState(): TranscriptState {
    return { items: [] };
}

export function appendUserItem(state: TranscriptState, displayText: string, submitText: string): void {
    state.items.push({ type: 'user', displayText, submitText, timestamp: Date.now() });
}

export function startAssistantItem(state: TranscriptState): void {
    state.items.push({ type: 'assistant', text: '', streaming: true, timestamp: Date.now() });
}

export function appendToActiveAssistant(state: TranscriptState, chunk: string): boolean {
    const last = state.items[state.items.length - 1];
    if (!last || last.type !== 'assistant' || !last.streaming) return false;
    last.text += chunk;
    return true;
}

export function finalizeAssistant(state: TranscriptState, fallbackText?: string): boolean {
    const last = state.items[state.items.length - 1];
    if (!last || last.type !== 'assistant') return false;
    if (last.streaming) {
        last.streaming = false;
    } else if (fallbackText) {
        // agent_done with text but no prior chunks
        last.text = fallbackText;
        last.streaming = false;
    }
    return true;
}

export function appendStatusItem(state: TranscriptState, text: string): void {
    // Ephemeral — replace previous status if it exists
    const last = state.items[state.items.length - 1];
    if (last?.type === 'status') {
        last.text = text;
        last.timestamp = Date.now();
        return;
    }
    state.items.push({ type: 'status', text, ephemeral: true, timestamp: Date.now() });
}

export function clearEphemeralStatus(state: TranscriptState): void {
    if (state.items.length > 0 && state.items[state.items.length - 1]?.type === 'status') {
        state.items.pop();
    }
}
