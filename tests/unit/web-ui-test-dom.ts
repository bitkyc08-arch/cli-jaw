import { JSDOM } from 'jsdom';

let observedElements: HTMLElement[] = [];
let unobservedElements: HTMLElement[] = [];
let dom: JSDOM | null = null;

class RecordingIntersectionObserver {
    readonly callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
    }

    observe(element: Element): void {
        observedElements.push(element as HTMLElement);
    }

    unobserve(element: Element): void {
        unobservedElements.push(element as HTMLElement);
    }

    disconnect(): void {
        observedElements = [];
    }

    takeRecords(): IntersectionObserverEntry[] {
        return [];
    }
}

class NoopResizeObserver {
    observe(): void { /* noop */ }
    unobserve(): void { /* noop */ }
    disconnect(): void { /* noop */ }
}

function installGlobal(name: string, value: unknown): void {
    Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
    });
}

export function setupWebUiDom(): void {
    observedElements = [];
    unobservedElements = [];
    dom = new JSDOM(`<!doctype html>
        <html><body>
            <main class="chat-area">
                <div id="chatMessages"></div>
                <div id="emptyState"></div>
                <div id="typingIndicator"></div>
                <div id="statusBadge"></div>
                <button id="btnSend"></button>
                <div id="statMsgs"></div>
            </main>
        </body></html>`, {
        url: 'http://127.0.0.1/',
        pretendToBeVisual: true,
    });

    const win = dom.window;
    installGlobal('window', win);
    installGlobal('document', win.document);
    installGlobal('HTMLElement', win.HTMLElement);
    installGlobal('Element', win.Element);
    installGlobal('Node', win.Node);
    installGlobal('NodeFilter', win.NodeFilter);
    installGlobal('navigator', win.navigator);
    installGlobal('localStorage', win.localStorage);
    installGlobal('MutationObserver', win.MutationObserver);
    installGlobal('getComputedStyle', win.getComputedStyle.bind(win));
    installGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => win.setTimeout(() => cb(Date.now()), 0));
    installGlobal('cancelAnimationFrame', (id: number) => win.clearTimeout(id));
    installGlobal('IntersectionObserver', RecordingIntersectionObserver);
    installGlobal('ResizeObserver', NoopResizeObserver);
    installGlobal('atob', win.atob.bind(win));
    installGlobal('btoa', win.btoa.bind(win));
    installGlobal('indexedDB', {
        open: () => {
            throw new Error('indexedDB is not available in web-ui-test-dom');
        },
    });
}

export function resetWebUiDom(): void {
    dom = null;
    observedElements = [];
    unobservedElements = [];
}

export function getObservedElements(): HTMLElement[] {
    return observedElements;
}

export function getUnobservedElements(): HTMLElement[] {
    return unobservedElements;
}
