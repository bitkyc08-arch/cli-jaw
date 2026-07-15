export const PRE_BIND_BUFFER_CAP = 64 * 1024;

export interface PreBindCandidate {
    data: string;
    exitSeen: boolean;
    exitCode: number | null;
}

export class TerminalPreBindBuffer {
    private readonly candidates = new Map<string, PreBindCandidate>();

    constructor(private readonly maxCandidates: number) {}

    captureData(id: string, data: string): void {
        const candidate = this.candidate(id);
        if (!candidate || candidate.data.length >= PRE_BIND_BUFFER_CAP) return;
        candidate.data += data.slice(0, PRE_BIND_BUFFER_CAP - candidate.data.length);
    }

    captureExit(id: string, code: number | null): void {
        const candidate = this.candidate(id);
        if (!candidate) return;
        candidate.exitSeen = true;
        candidate.exitCode = code;
    }

    take(id: string): PreBindCandidate | null {
        return this.candidates.get(id) ?? null;
    }

    clear(): void {
        this.candidates.clear();
    }

    private candidate(id: string): PreBindCandidate | null {
        const existing = this.candidates.get(id);
        if (existing) return existing;
        if (this.candidates.size >= this.maxCandidates) return null;
        const candidate: PreBindCandidate = { data: '', exitSeen: false, exitCode: null };
        this.candidates.set(id, candidate);
        return candidate;
    }
}
