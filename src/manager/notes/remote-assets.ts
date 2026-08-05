import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { notePathError } from '../../notes/path-guards.js';
import { MAX_NOTE_ASSET_BYTES, NotesAssetStore } from './assets.js';

const ALLOWED_REMOTE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_REDIRECTS = 3;
const REMOTE_FETCH_TIMEOUT_MS = 8000;

export type SaveRemoteNoteAssetRequest = {
    notePath: string;
    url: string;
};

function assertRemoteImageUrl(input: string): URL {
    if (typeof input !== 'string') {
        throw notePathError(400, 'note_asset_remote_invalid_url', 'Remote asset URL is required.');
    }
    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        throw notePathError(400, 'note_asset_remote_invalid_url', 'Remote asset URL is invalid.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw notePathError(400, 'note_asset_remote_invalid_url', 'Remote asset URL must use http or https.');
    }
    if (url.username || url.password) {
        throw notePathError(400, 'note_asset_remote_invalid_url', 'Remote asset URL must not include credentials.');
    }
    return url;
}

function isPrivateIpv4(address: string): boolean {
    const parts = address.split('.').map(part => Number(part));
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const a = parts[0]!;
    const b = parts[1]!;
    return a === 0
        || a === 10
        || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || a >= 224;
}

function isPrivateIpv6(address: string): boolean {
    const normalized = address.toLowerCase();
    return normalized === '::1'
        || normalized === '::'
        || normalized.startsWith('fc')
        || normalized.startsWith('fd')
        || normalized.startsWith('fe80:')
        || normalized.startsWith('::ffff:127.')
        || normalized.startsWith('::ffff:10.')
        || normalized.startsWith('::ffff:192.168.');
}

async function assertPublicHost(url: URL): Promise<void> {
    const hostname = url.hostname;
    const literal = isIP(hostname);
    const addresses = literal
        ? [{ address: hostname, family: literal }]
        : await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
        throw notePathError(400, 'note_asset_remote_host_blocked', 'Remote asset host could not be resolved.');
    }
    for (const entry of addresses) {
        const blocked = entry.family === 4
            ? isPrivateIpv4(entry.address)
            : isPrivateIpv6(entry.address);
        if (blocked) {
            throw notePathError(400, 'note_asset_remote_host_blocked', 'Remote asset host is not allowed.');
        }
    }
}

function contentTypeFrom(response: Response): string {
    return ((response.headers.get('content-type') || '').split(';')[0] || '').trim().toLowerCase();
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) {
        throw notePathError(502, 'note_asset_remote_fetch_failed', 'Remote asset response was empty.');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_NOTE_ASSET_BYTES) {
            throw notePathError(413, 'note_asset_too_large', 'Asset exceeds the maximum supported size.');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

export async function saveRemoteNoteAsset(
    store: NotesAssetStore,
    request: SaveRemoteNoteAssetRequest,
): Promise<Awaited<ReturnType<NotesAssetStore['saveAsset']>>> {
    let currentUrl = assertRemoteImageUrl(request.url);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        await assertPublicHost(currentUrl);
        const response = await fetch(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
            headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location || redirect === MAX_REDIRECTS) {
                throw notePathError(400, 'note_asset_remote_redirect_blocked', 'Remote asset redirect is not allowed.');
            }
            currentUrl = assertRemoteImageUrl(new URL(location, currentUrl).toString());
            continue;
        }
        if (!response.ok) {
            throw notePathError(502, 'note_asset_remote_fetch_failed', 'Remote asset fetch failed.');
        }
        const mime = contentTypeFrom(response);
        if (!ALLOWED_REMOTE_IMAGE_TYPES.has(mime)) {
            throw notePathError(415, 'note_asset_unsupported_type', 'Unsupported note asset type.');
        }
        const bytes = await readBoundedResponse(response);
        return await store.saveAsset({
            notePath: request.notePath,
            mime,
            dataBase64: bytes.toString('base64'),
        });
    }
    throw notePathError(400, 'note_asset_remote_redirect_blocked', 'Remote asset redirect is not allowed.');
}
