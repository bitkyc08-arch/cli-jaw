export class StatusUpdateBuffer {
    private pending = '';

    set(text: string): void {
        this.pending = text;
    }

    take(): string {
        const text = this.pending;
        this.pending = '';
        return text;
    }

    hasPending(): boolean {
        return this.pending.length > 0;
    }
}
