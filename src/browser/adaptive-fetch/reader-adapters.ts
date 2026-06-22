// Mirrored from agbrowse adaptive-fetch v2; keep runtime behavior aligned while cli-jaw mirror remains experimental.

import type { ReaderCandidate } from './types.js';
import { extractMetadataFromHtml } from './metadata.js';
import { normalizePublicEndpointResult } from './public-endpoint-normalizers.js';
import { htmlToReadableText, isHtmlContentType, normalizeWhitespace } from './transforms.js';

export function fromFetchResult(fetched: Record<string, unknown>, context: { source?: string; label?: string } = {}): ReaderCandidate {
    const publicEndpoint = normalizePublicEndpointResult(fetched, context);
    if (publicEndpoint) return normalizeReaderCandidate(publicEndpoint);
    const source = (context.source || 'fetch') as string;
    const isHtml = isHtmlContentType((fetched['contentType'] as string) || '');
    const metadata = isHtml ? extractMetadataFromHtml((fetched['text'] as string) || '', (fetched['finalUrl'] as string) || '') : null;
    const text = isHtml ? (metadata as Record<string, unknown>)['text'] as string : normalizeWhitespace((fetched['text'] as string) || '');
    return {
        source,
        label: context.label || source,
        finalUrl: (fetched['finalUrl'] as string) || '',
        title: ((metadata as Record<string, unknown> | null)?.['title'] as string) || '',
        text,
        contentType: (fetched['contentType'] as string) || '',
        status: Number(fetched['status'] || 0),
        ok: Boolean(fetched['ok']),
        metadata: ((metadata as Record<string, unknown> | null)?.['metadata'] as Record<string, unknown> | null) || null,
        evidence: [...((fetched['evidence'] as string[]) || []), ...(((metadata as Record<string, unknown> | null)?.['evidence'] as string[]) || [])],
        warnings: (fetched['warnings'] as string[]) || [],
        safetyFlags: [],
        rawTextLength: String(fetched['text'] || '').length,
    };
}

export function fromMetadataResult(result: Record<string, unknown>): ReaderCandidate {
    return normalizeReaderCandidate({
        source: 'metadata',
        label: 'metadata',
        finalUrl: result['finalUrl'],
        title: result['title'],
        text: result['text'],
        contentType: 'text/html',
        status: 200,
        ok: true,
        metadata: result['metadata'] || null,
        evidence: result['evidence'] || [],
        warnings: result['warnings'] || [],
    });
}

export function fromPublicEndpointResult(result: Record<string, unknown>): ReaderCandidate {
    return normalizeReaderCandidate({ ...result, source: 'public_endpoint', label: (result['label'] as string) || 'public_endpoint' });
}

export function fromBrowserResult(result: Record<string, unknown>): ReaderCandidate {
    return normalizeReaderCandidate({ ...result, source: 'browser', label: (result['label'] as string) || 'browser' });
}

export function fromNetworkCandidate(result: Record<string, unknown>): ReaderCandidate {
    return normalizeReaderCandidate({ ...result, source: 'network_api', label: (result['label'] as string) || 'network_api' });
}

export function normalizeReaderCandidates(results: Record<string, unknown>[] = []): ReaderCandidate[] {
    return results.map(normalizeReaderCandidate).filter(candidate => candidate.finalUrl || candidate.text);
}

export function normalizeReaderCandidate(result: Record<string, unknown> = {}): ReaderCandidate {
    return {
        source: (result['source'] as string) || 'reader',
        label: (result['label'] as string) || (result['source'] as string) || 'reader',
        finalUrl: (result['finalUrl'] as string) || '',
        title: normalizeWhitespace((result['title'] as string) || ''),
        text: normalizeWhitespace((result['text'] as string) || ''),
        contentType: (result['contentType'] as string) || '',
        status: Number(result['status'] || 0),
        ok: result['ok'] !== false,
        metadata: (result['metadata'] as Record<string, unknown> | null) || null,
        evidence: Array.isArray(result['evidence']) ? (result['evidence'] as unknown[]).filter(Boolean) as string[] : [],
        warnings: Array.isArray(result['warnings']) ? (result['warnings'] as unknown[]).filter(Boolean) as string[] : [],
        safetyFlags: Array.isArray(result['safetyFlags']) ? result['safetyFlags'] as string[] : [],
        rawTextLength: Number(result['rawTextLength'] || String(result['text'] || '').length),
    };
}

export function fromUserSessionResult(result: Record<string, unknown>): ReaderCandidate {
    return normalizeReaderCandidate({
        ...result,
        source: 'browser_user',
        label: (result['label'] as string) || 'browser-user-session',
        safetyFlags: [...((result['safetyFlags'] as string[]) || [])],
    });
}

export function fromHumanResolvedResult(result: Record<string, unknown>): ReaderCandidate {
    return normalizeReaderCandidate({
        source: 'human_resolved',
        label: 'human-resolved',
        finalUrl: (result['finalUrl'] ?? result['url'] ?? '') as string,
        title: (result['title'] ?? '') as string,
        text: (result['text'] ?? '') as string,
        contentType: (result['contentType'] ?? 'text/html') as string,
        status: (result['status'] ?? 200) as number,
        ok: true,
        evidence: ['human-resolved-challenge'],
        warnings: [],
        safetyFlags: ['user_session_used', 'human_action_taken'],
    });
}

export function fromHtmlText(html: string, finalUrl: string): ReaderCandidate {
    return normalizeReaderCandidate({
        source: 'reader',
        finalUrl,
        title: '',
        text: htmlToReadableText(html),
        contentType: 'text/html',
        status: 200,
        ok: true,
    });
}
