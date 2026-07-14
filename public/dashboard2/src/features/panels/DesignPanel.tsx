import { useEffect, useRef, useState, type JSX } from 'react';
import './panels.css';

export type DesignPanelProps = { active: boolean; url?: string };

export function DesignPanel({ active, url }: DesignPanelProps): JSX.Element {
    const viewportRef = useRef<HTMLDivElement>(null);
    const [revision, setRevision] = useState(0);
    const [size, setSize] = useState({ width: 0, height: 0 });

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!active || !viewport) return;
        const update = (): void => {
            const bounds = viewport.getBoundingClientRect();
            setSize({ width: Math.round(bounds.width), height: Math.round(bounds.height) });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(viewport);
        return () => observer.disconnect();
    }, [active]);

    function openInBrowser(): void {
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
    }

    return (
        <section className="d2-design-panel" hidden={!active} aria-label="Design preview">
            <header className="d2-panel-toolbar">
                <span className="d2-design-size" aria-label="Viewport dimensions">{size.width} × {size.height}</span>
                <button type="button" onClick={() => setRevision((value) => value + 1)} disabled={!url}>Refresh</button>
                <button type="button" onClick={openInBrowser} disabled={!url}>Open in browser</button>
            </header>
            <div ref={viewportRef} className="d2-design-viewport">
                {url ? (
                    <iframe key={`${url}:${revision}`} src={url} title="Design artifact" sandbox="allow-scripts allow-same-origin" />
                ) : (
                    <div className="d2-panel-state">Open a design artifact to preview it.</div>
                )}
            </div>
        </section>
    );
}
