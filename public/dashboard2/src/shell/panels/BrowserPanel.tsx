import { ArrowRight, LoaderCircle } from '@lucide/icons';
import { useState, type FormEvent, type JSX } from 'react';
import { Icon } from '../Icon.tsx';

function normalizeUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    // Only allow http/https schemes — block javascript:, data:, etc.
    if (/^https?:/i.test(trimmed)) return trimmed;
    if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return ''; // reject non-http schemes
    return `https://${trimmed}`;
}

export function BrowserPanel(): JSX.Element {
    const [draftUrl, setDraftUrl] = useState('');
    const [currentUrl, setCurrentUrl] = useState('');
    const [navigationId, setNavigationId] = useState(0);
    const [isLoading, setIsLoading] = useState(false);

    const navigate = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        const nextUrl = normalizeUrl(draftUrl);
        if (!nextUrl) return;
        setDraftUrl(nextUrl);
        setCurrentUrl(nextUrl);
        setNavigationId((current) => current + 1);
        setIsLoading(true);
    };

    return (
        <section className="d2-browser-panel" aria-label="Browser">
            <form className="d2-browser-url-bar" onSubmit={navigate}>
                <input
                    type="text"
                    inputMode="url"
                    value={draftUrl}
                    onChange={(event) => setDraftUrl(event.target.value)}
                    placeholder="Enter URL"
                    aria-label="URL"
                    spellCheck={false}
                />
                <button type="submit" aria-label="Go" title="Go" disabled={!draftUrl.trim()}>
                    <Icon icon={ArrowRight} size={15} />
                </button>
            </form>
            <div className="d2-browser-frame-wrap">
                {currentUrl ? (
                    <iframe
                        key={navigationId}
                        src={currentUrl}
                        title="Browser preview"
                        sandbox="allow-scripts allow-same-origin allow-forms"
                        onLoad={() => setIsLoading(false)}
                    />
                ) : (
                    <div className="d2-browser-empty">Enter a URL to start browsing</div>
                )}
                {isLoading ? (
                    <div className="d2-browser-loading" role="status">
                        <Icon icon={LoaderCircle} size={16} />
                        <span>Loading</span>
                    </div>
                ) : null}
            </div>
        </section>
    );
}
