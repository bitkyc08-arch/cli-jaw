/** Bounded input admission; an offer is not a provider acknowledgement. */
export function createClaudeInput<T>(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid input capacity');
    const items: T[] = [];
    let closed = false;
    let claimed = false;
    let reader: ((value: IteratorResult<T>) => void) | undefined;
    const close = (): void => {
        if (closed) return;
        closed = true;
        items.length = 0;
        const waiting = reader;
        reader = undefined;
        waiting?.({ done: true, value: undefined });
    };
    const stream: AsyncIterable<T> = {
        [Symbol.asyncIterator]() {
            if (claimed) throw new Error('Claude input has one consumer');
            claimed = true;
            return {
                next(): Promise<IteratorResult<T>> {
                    if (closed) return Promise.resolve({ done: true, value: undefined });
                    if (reader) return Promise.reject(new Error('Concurrent input next'));
                    if (items.length) return Promise.resolve({ done: false, value: items.shift()! });
                    return new Promise(resolve => { reader = resolve; });
                },
                return(): Promise<IteratorResult<T>> {
                    close();
                    return Promise.resolve({ done: true, value: undefined });
                },
            };
        },
    };
    return {
        stream,
        get size() { return items.length; },
        offer(value: T): boolean {
            if (closed || items.length >= limit) return false;
            if (reader) {
                const waiting = reader;
                reader = undefined;
                waiting({ done: false, value });
            } else items.push(value);
            return true;
        },
        close,
    };
}
