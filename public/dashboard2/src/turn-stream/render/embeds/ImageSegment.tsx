import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { RenderIdentity } from '../parse-coalescer.ts';
import { getRenderCache } from '../render-cache.ts';

const UPLOAD_PATH = /\.cli-jaw\/uploads\//i;

export function resolveImageSource(src: string, apiBase = ''): string {
    const upload = UPLOAD_PATH.test(src) || src.startsWith('/uploads/');
    if (upload) return `${apiBase}/media/${encodeURIComponent(src.split(/[\\/]/).pop() ?? '')}`;
    if (src.startsWith('/') || src.startsWith('~/')) return `${apiBase}/api/image?path=${encodeURIComponent(src)}`;
    return src;
}

export function ImageSegment({ src, alt, title, identity }: { src: string; alt: string; title?: string | undefined; identity: RenderIdentity }): ReactElement {
    const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
    const imageRef = useRef<HTMLImageElement>(null);
    const generation = useRef(0);
    const committed = useRef<'ready' | 'error' | null>(null);

    useEffect(() => {
        const current = ++generation.current;
        committed.current = null;
        setState('loading');
        const image = imageRef.current;
        if (!image) return;
        const commit = (next: 'ready' | 'error'): void => {
            if (generation.current !== current || committed.current === next) return;
            committed.current = next;
            setState(next);
            getRenderCache().invalidateHeights({ scopeKey: identity.scopeKey, turnId: identity.turnId });
        };
        const ready = (): void => commit('ready');
        const failed = (): void => commit('error');
        image.addEventListener('load', ready);
        image.addEventListener('error', failed);
        if (image.complete && image.naturalWidth > 0) ready();
        if (typeof image.decode === 'function') image.decode().then(ready, failed);
        return () => {
            generation.current += 1;
            image.removeEventListener('load', ready);
            image.removeEventListener('error', failed);
        };
    }, [src, identity.scopeKey, identity.turnId]);

    return <span className="d2-image-segment">
        {state !== 'error' ? <img ref={imageRef} src={resolveImageSource(src)} alt={alt} title={title} loading="lazy" decoding="async" /> : null}
        {state === 'error' ? <span role="status">{alt ? `Image unavailable: ${alt}` : 'Image unavailable'}</span> : null}
    </span>;
}
