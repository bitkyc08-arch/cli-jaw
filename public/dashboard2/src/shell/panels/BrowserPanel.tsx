import { ArrowLeft, ArrowRight, LoaderCircle, RotateCw, Square } from '@lucide/icons';
import {
    createElement,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type FormEvent,
    type JSX,
} from 'react';
import { useDesktopBridge } from '../../providers/desktop-bridge-provider.tsx';
import type { BrowserWebviewTabState } from '../../providers/desktop-bridge-contract.ts';
import { useAppScope } from '../../state/scope.tsx';
import { Icon } from '../Icon.tsx';

type ElectronWebviewElement = HTMLElement & {
    getWebContentsId?(): number;
};

type BrowserFailureEvent = Event & {
    errorCode?: number;
    errorDescription?: string;
    details?: { reason?: string };
};

interface BrowserPanelProps {
    panelId: string;
}

const openUrlOwners = new Map<number, string>();
let openedPanelOrdinal = 0;

function normalizeUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    if (/^https?:/i.test(trimmed)) return trimmed;
    if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return '';
    return `https://${trimmed}`;
}

function payloadUrl(payload: unknown): string {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
    const url = (payload as Record<string, unknown>)['url'];
    return typeof url === 'string' ? normalizeUrl(url) : '';
}

function WebIframeBrowser({ initialUrl }: { initialUrl: string }): JSX.Element {
    const [draftUrl, setDraftUrl] = useState(initialUrl);
    const [currentUrl, setCurrentUrl] = useState(initialUrl);
    const [navigationId, setNavigationId] = useState(0);
    const [isLoading, setIsLoading] = useState(Boolean(initialUrl));

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
                <input type="text" inputMode="url" value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} placeholder="Enter URL" aria-label="URL" spellCheck={false} />
                <button type="submit" aria-label="Go" title="Go" disabled={!draftUrl.trim()}><Icon icon={ArrowRight} size={15} /></button>
            </form>
            <div className="d2-browser-frame-wrap">
                {currentUrl ? (
                    <iframe key={navigationId} src={currentUrl} title="Browser preview" sandbox="allow-scripts allow-same-origin allow-forms" onLoad={() => setIsLoading(false)} />
                ) : <div className="d2-browser-empty">Enter a URL to start browsing</div>}
                {isLoading ? <LoadingStatus /> : null}
            </div>
        </section>
    );
}

function LoadingStatus(): JSX.Element {
    return <div className="d2-browser-loading" role="status"><Icon icon={LoaderCircle} size={16} /><span>Loading</span></div>;
}

function ElectronWebviewBrowser({ panelId, initialUrl }: BrowserPanelProps & { initialUrl: string }): JSX.Element {
    const { browser } = useDesktopBridge();
    const { openPanel } = useAppScope();
    const native = browser.native;
    const tabId = useMemo(() => `browser:${panelId}:1`, [panelId]);
    const [draftUrl, setDraftUrl] = useState(initialUrl);
    const [mountUrl, setMountUrl] = useState(initialUrl);
    const [state, setState] = useState<BrowserWebviewTabState | null>(null);
    const [localError, setLocalError] = useState<string | null>(null);
    const registeredWebContentsId = useRef<number | null>(null);
    const webviewRef = useRef<ElectronWebviewElement | null>(null);

    const applyBridgeState = useCallback((next: BrowserWebviewTabState | undefined): void => {
        if (!next || next.tabId !== tabId) return;
        setState(next);
        if (next.url && next.url !== 'about:blank') setDraftUrl(next.url);
        if (next.error) setLocalError(next.error);
        else if (!next.crashed) setLocalError(null);
    }, [tabId]);

    const unregister = useCallback((webContentsId: number | null): void => {
        if (typeof webContentsId !== 'number') return;
        if (openUrlOwners.get(webContentsId) === panelId) openUrlOwners.delete(webContentsId);
        if (registeredWebContentsId.current === webContentsId) registeredWebContentsId.current = null;
        void native?.unregisterWebview({ tabId, webContentsId });
    }, [native, panelId, tabId]);

    const register = useCallback((webview: ElectronWebviewElement): void => {
        const webContentsId = webview.getWebContentsId?.();
        if (typeof webContentsId !== 'number') {
            setLocalError('Desktop browser registration unavailable');
            return;
        }
        const previous = registeredWebContentsId.current;
        if (typeof previous === 'number' && previous !== webContentsId) unregister(previous);
        registeredWebContentsId.current = webContentsId;
        openUrlOwners.set(webContentsId, panelId);
        void native?.registerWebview({ tabId, webContentsId }).then((result) => {
            if (registeredWebContentsId.current !== webContentsId) return;
            if (!result.ok) {
                setLocalError(result.error ?? 'Desktop browser registration failed');
                return;
            }
            applyBridgeState(result.state);
        }).catch((error: unknown) => {
            if (registeredWebContentsId.current === webContentsId) {
                setLocalError(error instanceof Error ? error.message : 'Desktop browser registration failed');
            }
        });
    }, [applyBridgeState, native, panelId, tabId, unregister]);

    const setWebviewRef = useCallback((node: Element | null): void => {
        const previous = webviewRef.current;
        if (previous === node) return;
        if (previous) unregister(registeredWebContentsId.current);
        webviewRef.current = node as ElectronWebviewElement | null;
    }, [unregister]);

    useEffect(() => {
        const webview = webviewRef.current;
        if (!webview) return undefined;
        const onDomReady = (): void => register(webview);
        const onFail = (event: Event): void => {
            const failure = event as BrowserFailureEvent;
            setLocalError(failure.errorDescription ?? `Navigation failed (${failure.errorCode ?? 'unknown'})`);
        };
        const onGone = (event: Event): void => {
            const reason = (event as BrowserFailureEvent).details?.reason ?? 'gone';
            setLocalError(`Browser process ${reason}. Reload to retry.`);
            setState((current) => current ? { ...current, loading: false, crashed: true } : current);
        };
        webview.addEventListener('dom-ready', onDomReady);
        webview.addEventListener('did-fail-load', onFail);
        webview.addEventListener('render-process-gone', onGone);
        return () => {
            webview.removeEventListener('dom-ready', onDomReady);
            webview.removeEventListener('did-fail-load', onFail);
            webview.removeEventListener('render-process-gone', onGone);
        };
    }, [mountUrl, register]);

    useEffect(() => {
        if (!native) return undefined;
        return native.onWebviewState(applyBridgeState);
    }, [applyBridgeState, native]);

    const control = useCallback(async (command: Parameters<NonNullable<typeof native>['controlWebview']>[0]): Promise<void> => {
        if (!native || registeredWebContentsId.current === null) return;
        const result = await native.controlWebview(command);
        if (!result.ok) setLocalError(result.error ?? 'Browser command failed');
        else applyBridgeState(result.state);
    }, [applyBridgeState, native]);

    const navigateTo = useCallback((url: string): void => {
        const nextUrl = normalizeUrl(url);
        if (!nextUrl) return;
        setDraftUrl(nextUrl);
        setLocalError(null);
        if (registeredWebContentsId.current === null) setMountUrl(nextUrl);
        else void control({ kind: 'navigate', tabId, url: nextUrl });
    }, [control, tabId]);

    useEffect(() => {
        if (!native) return undefined;
        return native.onOpenUrl((payload) => {
            if (typeof payload.sourceWebContentsId !== 'number') return;
            if (openUrlOwners.get(payload.sourceWebContentsId) !== panelId) return;
            if (payload.disposition === 'current-tab') {
                navigateTo(payload.url);
                return;
            }
            openedPanelOrdinal += 1;
            openPanel({
                type: 'browser',
                key: `browser:open-url:${openedPanelOrdinal}`,
                title: 'Browser',
                payload: { url: payload.url },
                keepAlive: true,
            });
        });
    }, [native, navigateTo, openPanel, panelId]);

    useEffect(() => () => unregister(registeredWebContentsId.current), [unregister]);

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        navigateTo(draftUrl);
    };
    const title = state?.title || 'Browser';
    const statusError = localError ?? state?.error ?? (state?.crashed ? 'Browser process crashed. Reload to retry.' : null);

    return (
        <section className="d2-browser-panel" aria-label={title}>
            <form className="d2-browser-url-bar" onSubmit={submit}>
                <button type="button" aria-label="Back" title="Back" disabled={!state?.canGoBack} onClick={() => void control({ kind: 'goBack', tabId })}><Icon icon={ArrowLeft} size={15} /></button>
                <button type="button" aria-label="Forward" title="Forward" disabled={!state?.canGoForward} onClick={() => void control({ kind: 'goForward', tabId })}><Icon icon={ArrowRight} size={15} /></button>
                <button type="button" aria-label="Reload" title="Reload" disabled={!state} onClick={() => void control({ kind: 'reload', tabId })}><Icon icon={RotateCw} size={15} /></button>
                <button type="button" aria-label="Stop" title="Stop" disabled={!state?.loading} onClick={() => void control({ kind: 'stop', tabId })}><Icon icon={Square} size={13} /></button>
                <input type="text" inputMode="url" value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} placeholder="Enter URL" aria-label="URL" spellCheck={false} />
                <button type="submit" aria-label="Go" title="Go" disabled={!draftUrl.trim()}><Icon icon={ArrowRight} size={15} /></button>
                <button
                    type="button"
                    className="d2-browser-agent-toggle"
                    data-shared={state?.sharedWithAgent ? 'true' : 'false'}
                    aria-label={state?.sharedWithAgent ? 'Stop sharing with agent' : 'Share with agent'}
                    title={state?.sharedWithAgent ? 'Shared with agent' : 'Not shared with agent'}
                    disabled={!state}
                    onClick={() => void native?.performWebviewAction({ kind: 'setSharedWithAgent', tabId, shared: !state?.sharedWithAgent }).then((result) => applyBridgeState(result.state))}
                >{state?.sharedWithAgent ? 'Agent on' : 'Agent off'}</button>
            </form>
            <div className="d2-browser-frame-wrap">
                {mountUrl ? createElement('webview', {
                    ref: setWebviewRef,
                    src: mountUrl,
                    title,
                    style: { display: 'block', width: '100%', height: '100%', border: 0 },
                }) : <div className="d2-browser-empty">Enter a URL to start browsing</div>}
                {state?.loading ? <LoadingStatus /> : null}
                {statusError ? <div className="d2-browser-empty" role="alert">{statusError}</div> : null}
                <span className="sr-only" aria-live="polite">{state?.loading ? `Loading ${state.url}` : `${title}${state?.url ? ` — ${state.url}` : ''}`}</span>
            </div>
        </section>
    );
}

export function BrowserPanel({ panelId }: BrowserPanelProps): JSX.Element {
    const bridge = useDesktopBridge();
    const { panelInstances } = useAppScope();
    const panel = panelInstances.find((candidate) => candidate.id === panelId);
    const initialUrl = payloadUrl(panel?.payload);

    if (!bridge.environment.isElectron) return <WebIframeBrowser initialUrl={initialUrl} />;
    if (!bridge.browser.nativeAvailable || !bridge.browser.nativeWired || !bridge.browser.native) {
        return <section className="d2-browser-panel" aria-label="Browser"><div className="d2-browser-empty" role="alert">Desktop browser unavailable</div></section>;
    }
    return <ElectronWebviewBrowser panelId={panelId} initialUrl={initialUrl} />;
}
