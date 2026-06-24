// Mirrored from agbrowse adaptive-fetch v2; keep runtime behavior aligned while cli-jaw mirror remains experimental.

import type { ReaderCandidate } from './types.js';
import { classifyBoundarySignals, findBoundaryMarkers } from './validators.js';

const SOURCE_TRUST: Record<string, number> = {
    public_endpoint: 20,
    network_api: 16,
    fetch: 12,
    browser: 10,
    metadata: 6,
    third_party_reader: 5,
    reader: 4,
};

interface ScoreOptions {
    minStrongScore?: number;
    minWeakScore?: number;
}

export interface ScoredResult {
    candidate: ReaderCandidate;
    score: number;
    verdict: string;
    markers: { kind: string; pattern: string }[];
    textLength: number;
    density: number;
    evidence: string[];
}

export function scoreReaderCandidate(candidate: ReaderCandidate, options: ScoreOptions = {}): ScoredResult {
    const text = String(candidate.text || '');
    const title = String(candidate.title || '');
    const metadata = candidate.metadata || {};
    const markers = findBoundaryMarkers(`${title}\n${text}`);
    const textLength = text.length;
    const density = computeTextDensity(text, Number(candidate.rawTextLength || textLength));
    const metadataEvidence = countMetadataEvidence(metadata);
    const boundary = classifyBoundarySignals({
        status: candidate.status,
        text: `${title}\n${text}`,
    });
    let score = 0;
    score += Math.min(45, Math.floor(textLength / 80));
    score += Math.min(20, Math.floor(density * 20));
    score += title.length >= 8 ? 8 : 0;
    score += Math.min(15, metadataEvidence * 5);
    score += SOURCE_TRUST[candidate.source] || 0;
    if (candidate.ok === false || Number(candidate.status || 0) >= 400) {
        score = 0;
        const verdict = boundary.verdict || 'blocked';
        return {
            candidate,
            score,
            verdict,
            markers: boundary.markers || markers,
            textLength,
            density,
            evidence: buildScoreEvidence(candidate, {
                score,
                textLength,
                density,
                metadataEvidence,
                markers: boundary.markers || markers,
                extra: ['candidate-not-ok', candidate.status ? `http-${candidate.status}` : null, boundary.reason],
            }),
        };
    }
    for (const marker of markers) {
        if (marker.kind === 'challenge') score -= 25;
        if (marker.kind === 'auth') score -= 35;
        if (marker.kind === 'paywall') score -= 25;
    }
    score = Math.max(0, score);
    const verdict = verdictFromScore({ score, markers, textLength }, options);
    return {
        candidate,
        score,
        verdict,
        markers,
        textLength,
        density,
        evidence: buildScoreEvidence(candidate, { score, textLength, density, metadataEvidence, markers }),
    };
}

export function chooseBestReaderCandidate(candidates: ReaderCandidate[] = [], options: ScoreOptions = {}): ScoredResult | null {
    const scored = candidates.map(candidate => scoreReaderCandidate(candidate, options));
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
}

interface ScoredInput {
    score: number;
    markers?: { kind: string; pattern: string }[];
    textLength?: number;
}

export function verdictFromScore(scored: ScoredInput, options: ScoreOptions = {}): string {
    const minStrongScore = Number(options.minStrongScore || 50);
    const minWeakScore = Number(options.minWeakScore || 20);
    const markers = scored.markers || [];
    const textLength = Number(scored.textLength || 0);
    if (markers.some(m => m.kind === 'auth') && textLength < 1500) return 'auth_required';
    if (markers.some(m => m.kind === 'paywall') && textLength < 1500) return 'paywall';
    if (markers.some(m => m.kind === 'challenge') && textLength < 1000) return 'challenge';
    if (scored.score >= minStrongScore) return 'strong_ok';
    if (scored.score >= minWeakScore) return 'weak_ok';
    return 'blocked';
}

function computeTextDensity(text: string, rawLength: number): number {
    if (!rawLength || rawLength <= 0) return text.length > 0 ? 1 : 0;
    return Math.max(0, Math.min(1, text.length / rawLength));
}

function countMetadataEvidence(metadata: Record<string, unknown>): number {
    let count = 0;
    if (metadata['canonicalUrl']) count += 1;
    if (metadata['description']) count += 1;
    if (metadata['openGraph'] && typeof metadata['openGraph'] === 'object' && Object.keys(metadata['openGraph'] as object).length > 0) count += 1;
    if (Array.isArray(metadata['jsonLd']) && metadata['jsonLd'].length > 0) count += 1;
    return count;
}

interface ScoreEvidenceInput {
    score: number;
    textLength: number;
    density: number;
    metadataEvidence: number;
    markers: { kind: string; pattern: string }[];
    extra?: (string | null | undefined)[];
}

function buildScoreEvidence(candidate: ReaderCandidate, scored: ScoreEvidenceInput): string[] {
    return [
        `score:${scored.score}`,
        `source:${candidate.source}`,
        `text:${scored.textLength}`,
        `density:${scored.density.toFixed(2)}`,
        scored.metadataEvidence ? `metadata:${scored.metadataEvidence}` : null,
        ...scored.markers.map(marker => `marker:${marker.kind}`),
        ...(scored.extra || []),
        ...(candidate.evidence || []),
    ].filter((v): v is string => v != null);
}
