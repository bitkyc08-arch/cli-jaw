// Mirrored from agbrowse adaptive-fetch v2; keep runtime behavior aligned while cli-jaw mirror remains experimental.

import type { WafProfile } from './types.js';
import { findBoundaryMarkers } from './validators.js';
import { WAF_PROFILES, scoreProfile } from './waf-profiles.js';

interface DetectInput {
    url?: string;
    status?: number;
    text?: string;
    title?: string;
}

interface ResponseInput {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    cookies?: string[];
}

export function detectChallengeMarkers(input: DetectInput = {}): { kind: string; pattern: string }[] {
    return findBoundaryMarkers(`${input.url || ''}\n${input.status || ''}\n${input.title || ''}\n${input.text || ''}`);
}

export function classifyAccessBoundary(markers: { kind: string }[] = []): string | null {
    if (markers.some(marker => marker.kind === 'auth')) return 'auth_required';
    if (markers.some(marker => marker.kind === 'paywall')) return 'paywall';
    if (markers.some(marker => marker.kind === 'challenge')) return 'challenge';
    return null;
}

export function detectWafChallenge(response: ResponseInput) {
    const signals = {
        cookies: response.cookies || parseCookieNames(response.headers || {}),
        headers: response.headers || {},
        body: response.body?.substring(0, 50000) ?? '',
        status: response.status || 0,
    };

    const matches = WAF_PROFILES
        .map((p: WafProfile) => ({ profile: p, score: scoreProfile(p, signals) }))
        .filter((m: { profile: WafProfile; score: number }) => m.score >= 2)
        .sort((a: { score: number }, b: { score: number }) => b.score - a.score);

    return {
        detected: matches.length > 0,
        profiles: matches,
        primary: matches[0] ?? null,
        signals: { cookieCount: signals.cookies.length, status: signals.status },
    };
}

export function detectLoginWall(text: string) {
    const markers = findBoundaryMarkers(text);
    const authMarkers = markers.filter(m => m.kind === 'auth');
    return { detected: authMarkers.length > 0, markers: authMarkers };
}

export function detectPaywall(text: string) {
    const markers = findBoundaryMarkers(text);
    const paywallMarkers = markers.filter(m => m.kind === 'paywall');
    return { detected: paywallMarkers.length > 0, markers: paywallMarkers };
}

export function classifyChallengeType(response: ResponseInput) {
    const waf = detectWafChallenge(response);
    const textContent = (response.body || '').substring(0, 50000);
    const login = detectLoginWall(textContent);
    const paywall = detectPaywall(textContent);

    if (waf.detected) return { type: 'challenge' as const, ...waf };
    if (login.detected) return { type: 'auth_required' as const, ...login };
    if (paywall.detected) return { type: 'paywall' as const, ...paywall };
    return { type: null };
}

function parseCookieNames(headers: Record<string, string>): string[] {
    const setCookie = headers['set-cookie'] || headers['Set-Cookie'] || '';
    if (!setCookie) return [];
    return setCookie.split(/,(?=[^;]*=)/).map(c => {
        const name = c.trim().split('=')[0];
        return name || '';
    }).filter(Boolean);
}
