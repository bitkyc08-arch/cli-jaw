import { useEffect, useRef, useState, type ReactElement } from 'react';
import { usePreferences } from '../../../providers/preferences-provider.tsx';
import { renderCopy } from '../../render/copy-catalog.ts';
import { createKatexHydrator, type MathHydrationResult } from '../../render/katex-hydrator.ts';
import type { MarkdownSlot } from '../../render/markdown-slot-manifest.ts';
import { sanitizedHtmlProps, type SanitizedHtml } from '../../render/sanitize-policy.ts';

export function MathSlot({ slot, scrollRoot }: { slot: Extract<MarkdownSlot, { kind: 'math' }>; scrollRoot: Element | null }): ReactElement {
    const { locale } = usePreferences();
    const renderLocale = locale.locale === 'ko' ? 'ko' : 'en';
    const element = useRef<HTMLSpanElement>(null);
    const [html, setHtml] = useState<SanitizedHtml | null>(null);
    const [failed, setFailed] = useState(false);
    const generation = useRef(0);
    const sizeKiB = Math.ceil(new TextEncoder().encode(slot.tex).byteLength / 1024);
    useEffect(() => {
        setHtml(null); setFailed(false);
        if (!element.current || sizeKiB > 32) return undefined;
        const mine = ++generation.current;
        const container = element.current.parentElement;
        if (!container) return undefined;
        const hydrator = createKatexHydrator({
            container, scrollRoot: scrollRoot ?? document.documentElement, slots: [slot], generation: mine,
            currentGeneration: () => generation.current, locale: renderLocale,
            onResult: (_slot, result: MathHydrationResult) => {
                if (result.kind === 'ready') setHtml(result.html); else setFailed(true);
            },
        });
        try {
            return () => { generation.current += 1; hydrator.dispose(); };
        } catch { setFailed(true); return undefined; }
    }, [renderLocale, scrollRoot, sizeKiB, slot]);
    const label = sizeKiB > 32 ? renderCopy(renderLocale, 'math.oversize', { sizeKiB }) : failed ? renderCopy(renderLocale, 'math.error') : '';
    return <span ref={element} className={`d2-math-slot${html ? ' is-ready' : ''}${label ? ' is-error' : ''}`} data-math-state={html ? 'ready' : label ? 'error' : 'pending'}>{label ? <span className="d2-math-slot__label">{label}</span> : null}{html ? <span dangerouslySetInnerHTML={sanitizedHtmlProps(html)} /> : <span className="d2-math-slot__source">{slot.tex}</span>}</span>;
}
