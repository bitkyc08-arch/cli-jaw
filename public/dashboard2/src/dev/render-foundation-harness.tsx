import { useEffect, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { ManagerPreferencesProvider, usePreferences, type PreferencesRegistryClient } from '../providers/preferences-provider.tsx';
import { LegacyMessageRow } from '../turn-stream/components/LegacyMessageRow.tsx';
import { MarkdownSegment } from '../turn-stream/components/MarkdownSegment.tsx';
import { MathSlot } from '../turn-stream/components/segments/MathSlot.tsx';
import { ToolLine } from '../turn-stream/components/segments/ToolLine.tsx';
import { WidgetSegment } from '../turn-stream/components/segments/WidgetSegment.tsx';
import { getRenderCache } from '../turn-stream/render/render-cache.ts';

if (import.meta.env.PROD) throw new Error('render-foundation-harness is dev/test-only');

export interface RenderFoundationHarness {
    feed(text: string): void;
    feedMath(tex: string, offsetPx: number): void;
    mountXss(role: 'user' | 'assistant', text: string): void;
    setLocale(locale: 'ko' | 'en'): void;
    cacheStats(): { markdown: { count: number; bytes: number }; height: { count: number; bytes: number } };
}

let setStreamText: (text: string) => void = () => {};
let setFixture: (fixture: { role: 'user' | 'assistant'; text: string }) => void = () => {};
let setHarnessLocale: (locale: 'ko' | 'en') => void = () => {};
let setMathFixture: (fixture: { tex: string; offsetPx: number }) => void = () => {};

function FixtureApp(): JSX.Element {
    const [stream, updateStream] = useState('');
    const [fixture, updateFixture] = useState<{ role: 'user' | 'assistant'; text: string }>({ role: 'assistant', text: '' });
    const [mathFixture, updateMathFixture] = useState({ tex: '', offsetPx: 0 });
    const { locale } = usePreferences();
    useEffect(() => { setStreamText = updateStream; setFixture = updateFixture; setHarnessLocale = locale.setLocale; setMathFixture = updateMathFixture; }, [locale.setLocale]);
    const segment = { segmentId: 'harness-tool' } as never;
    const mathSlot = { id: 'harness-math', kind: 'math' as const, tex: mathFixture.tex, displayMode: true, ordinal: 0 };
    return (
        <main className="d2-turn-scroll" style={{ height: '720px', overflow: 'auto' }}>
            <section data-testid="xss-fixture">
                <LegacyMessageRow message={{ id: 1, role: fixture.role, content: fixture.text, createdAt: '' }} />
            </section>
            <section data-testid="streaming"><MarkdownSegment text={stream} mode="streaming" identity={{ scopeKey: 'harness', turnId: 'stream', segmentId: 'stream:body' }} /></section>
            <section data-testid="final"><MarkdownSegment text={stream} /></section>
            <section data-testid="math-viewport-fixture" style={{ paddingTop: mathFixture.offsetPx }}>
                {mathFixture.tex ? <div><MathSlot slot={mathSlot} scrollRoot={null} /><span data-render-slot={mathSlot.id} /></div> : null}
            </section>
            <ToolLine segment={segment} traceSeq={7} status="done" expanded={false} onToggle={() => {}} />
            <WidgetSegment descriptor={{ widgetId: 'fixture', title: 'Widget fixture', estimatedHeight: 80 }} expanded={false} onToggle={() => {}} />
        </main>
    );
}

const client: PreferencesRegistryClient = {
    async load() {
        return { registry: { ui: { uiTheme: 'auto', locale: 'ko', dashboardShortcutsEnabled: true, dashboardShortcutKeymap: 'default' } } as never, status: {} };
    },
    async patch(patch) {
        return { registry: { ui: { uiTheme: 'auto', locale: patch.ui?.locale ?? 'ko', dashboardShortcutsEnabled: true, dashboardShortcutKeymap: 'default' } } as never, status: {} };
    },
};

declare global { interface Window { __jawRenderFoundation?: RenderFoundationHarness } }

export function mountRenderFoundationHarness(): RenderFoundationHarness {
    const host = document.createElement('div');
    host.id = 'render-foundation-host';
    document.body.replaceChildren(host);
    createRoot(host).render(<ManagerPreferencesProvider client={client}><FixtureApp /></ManagerPreferencesProvider>);
    const cache = getRenderCache();
    const harness: RenderFoundationHarness = {
        feed: (text) => setStreamText(text),
        feedMath: (tex, offsetPx) => setMathFixture({ tex, offsetPx }),
        mountXss: (role, text) => setFixture({ role, text }),
        setLocale: (locale) => setHarnessLocale(locale),
        cacheStats: () => ({ markdown: cache.stats('markdown'), height: cache.stats('height') }),
    };
    window.__jawRenderFoundation = harness;
    return harness;
}
