import { useEffect, useMemo, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { ManagerPreferencesProvider, usePreferences, type PreferencesRegistryClient } from '../providers/preferences-provider.tsx';
import { LegacyMessageRow } from '../turn-stream/components/LegacyMessageRow.tsx';
import { MarkdownSegment } from '../turn-stream/components/MarkdownSegment.tsx';
import { MathSlot } from '../turn-stream/components/segments/MathSlot.tsx';
import { ToolLine } from '../turn-stream/components/segments/ToolLine.tsx';
import { WidgetSegment } from '../turn-stream/components/segments/WidgetSegment.tsx';
import type { WidgetDescriptor } from '../turn-stream/widgets/widget-segment-adapter.ts';
import { getRenderCache } from '../turn-stream/render/render-cache.ts';
import { DesktopBridgeProvider } from '../providers/desktop-bridge-provider.tsx';
import { RenderActionPortsProvider } from '../providers/render-action-ports.tsx';

if (import.meta.env.PROD) throw new Error('render-foundation-harness is dev/test-only');

export interface RenderFoundationHarness {
    ready(): boolean;
    feed(text: string): void;
    feedFinal(text: string): void;
    feedStreaming(text: string): void;
    feedMath(tex: string, offsetPx: number): void;
    mountXss(role: 'user' | 'assistant', text: string): void;
    setLocale(locale: 'ko' | 'en'): void;
    setLinkPreviews(enabled: boolean): void;
    setHidden(hidden: boolean): void;
    setWidgetMode(mode: 'none' | 'live' | 'completed' | 'mermaid'): void;
    unmount(): void;
    cacheStats(): { markdown: { count: number; bytes: number }; height: { count: number; bytes: number } };
}

let setStreamText: (text: string) => void = () => {};
let setFinalText: (text: string) => void = () => {};
let setFixture: (fixture: { role: 'user' | 'assistant'; text: string }) => void = () => {};
let setHarnessLocale: (locale: 'ko' | 'en') => void = () => {};
let setMathFixture: (fixture: { tex: string; offsetPx: number }) => void = () => {};
let harnessReady = false;
let setPreviewEnabled: (enabled: boolean) => void = () => {};
let setHarnessHidden: (hidden: boolean) => void = () => {};
let setHarnessWidgetMode: (mode: 'none' | 'live' | 'completed' | 'mermaid') => void = () => {};

function FixtureApp(): JSX.Element {
    const [stream, updateStream] = useState('');
    const [finalText, updateFinalText] = useState('');
    const [fixture, updateFixture] = useState<{ role: 'user' | 'assistant'; text: string }>({ role: 'assistant', text: '' });
    const [mathFixture, updateMathFixture] = useState({ tex: '', offsetPx: 0 });
    const [hidden, updateHidden] = useState(false);
    const [widgetMode, updateWidgetMode] = useState<'none' | 'live' | 'completed' | 'mermaid'>('none');
    const [liveExpanded, setLiveExpanded] = useState(true);
    const [completedExpanded, setCompletedExpanded] = useState(false);
    const { locale, linkPreviews } = usePreferences();
    useEffect(() => {
        setStreamText = updateStream; setFinalText = updateFinalText; setFixture = updateFixture; setHarnessLocale = locale.setLocale; setMathFixture = updateMathFixture;
        setPreviewEnabled = linkPreviews.setEnabled; setHarnessHidden = updateHidden; setHarnessWidgetMode = updateWidgetMode; harnessReady = true;
        return () => { harnessReady = false; };
    }, [linkPreviews.setEnabled, locale.setLocale]);
    const segment = { segmentId: 'harness-tool' } as never;
    const mathSlot = { id: 'harness-math', kind: 'math' as const, tex: mathFixture.tex, displayMode: true, ordinal: 0 };
    const inlineWidget = useMemo<WidgetDescriptor>(() => ({ widgetId: 'fixture-widget', title: 'Widget fixture', estimatedHeight: 80, storage: 'inline', revision: 'r1', capabilities: ['interactive'], source: btoa('<!doctype html><button>runtime</button>') }), []);
    const liveWidgetIdentity = useMemo(() => ({ scopeKey: 'harness', turnId: 'live', segmentId: 'widget' }), []);
    const completedWidgetIdentity = useMemo(() => ({ scopeKey: 'harness', turnId: 'done', segmentId: 'widget' }), []);
    return (
        <main className="d2-turn-scroll" data-hidden={hidden || undefined} style={{ height: '720px', overflow: 'auto', display: hidden ? 'none' : undefined }}>
            {hidden ? null : <>
            <section data-testid="xss-fixture">
                <LegacyMessageRow message={{ id: 1, role: fixture.role, content: fixture.text, createdAt: '' }} />
            </section>
            <section data-testid="streaming"><MarkdownSegment text={stream} mode="streaming" identity={{ scopeKey: 'harness', turnId: 'stream', segmentId: 'stream:body' }} /></section>
            <section data-testid="final"><MarkdownSegment text={finalText} identity={{ scopeKey: 'harness', turnId: 'final', segmentId: 'final:body' }} /></section>
            <section data-testid="math-viewport-fixture" style={{ paddingTop: mathFixture.offsetPx }}>
                {mathFixture.tex ? <div><MathSlot slot={mathSlot} scrollRoot={null} /><span data-render-slot={mathSlot.id} /></div> : null}
            </section>
            <ToolLine segment={segment} traceSeq={7} status="done" expanded={false} onToggle={() => {}} />
            {widgetMode === 'live' ? <section data-testid="live-widget"><WidgetSegment descriptor={inlineWidget} expanded={liveExpanded} onToggle={() => setLiveExpanded(value => !value)} identity={liveWidgetIdentity} chatId="harness" /></section> : null}
            {widgetMode === 'completed' ? <section data-testid="completed-widget"><WidgetSegment descriptor={inlineWidget} expanded={completedExpanded} onToggle={() => setCompletedExpanded(value => !value)} identity={completedWidgetIdentity} chatId="harness" /></section> : null}
            {widgetMode === 'mermaid' ? <section data-testid="mermaid-widget-rule"><MarkdownSegment text={'```mermaid\nflowchart LR\nA-->B\n```'} /></section> : null}
            </>}
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
    const root = createRoot(host);
    root.render(
        <ManagerPreferencesProvider client={client}>
            <DesktopBridgeProvider>
                <RenderActionPortsProvider ports={{ workerPort: 3458 }}><FixtureApp /></RenderActionPortsProvider>
            </DesktopBridgeProvider>
        </ManagerPreferencesProvider>,
    );
    const cache = getRenderCache();
    const harness: RenderFoundationHarness = {
        ready: () => harnessReady,
        feed: (text) => { setStreamText(text); setFinalText(text); },
        feedFinal: (text) => setFinalText(text),
        feedStreaming: (text) => setStreamText(text),
        feedMath: (tex, offsetPx) => setMathFixture({ tex, offsetPx }),
        mountXss: (role, text) => setFixture({ role, text }),
        setLocale: (locale) => setHarnessLocale(locale),
        setLinkPreviews: (enabled) => setPreviewEnabled(enabled),
        setHidden: (hidden) => setHarnessHidden(hidden),
        setWidgetMode: (mode) => setHarnessWidgetMode(mode),
        unmount: () => { root.unmount(); delete window.__jawRenderFoundation; },
        cacheStats: () => ({ markdown: cache.stats('markdown'), height: cache.stats('height') }),
    };
    window.__jawRenderFoundation = harness;
    return harness;
}
