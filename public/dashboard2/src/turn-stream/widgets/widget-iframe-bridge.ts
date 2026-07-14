export interface WidgetBridgeCallbacks {
    onResize(height: number): void;
    onSend?(text: string): void;
    onCopy?(text: string): void;
}

interface RuntimeRegistration extends WidgetBridgeCallbacks { iframe: HTMLIFrameElement; nonce: string }

const CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://esm.sh; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://esm.sh";

export function buildWidgetSrcdoc(source: string, nonce: string, tokens: Record<string, string> = {}): string {
    const vars = Object.entries(tokens).map(([key, value]) => `${key}:${value}`).join(';');
    const bridge = `<script>(()=>{const n=${JSON.stringify(nonce)};const post=(type,value)=>parent.postMessage({type,nonce:n,...value},'*');const resize=()=>post('jaw-diagram-resize',{height:Math.ceil(document.documentElement.scrollHeight)});addEventListener('load',resize);new ResizeObserver(resize).observe(document.documentElement)})();<\/script>`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>:root{${vars}}*{box-sizing:border-box}body{margin:0;background:transparent;color:var(--text);font-family:var(--font-ui),system-ui,sans-serif}</style></head><body>${bridge}${source}</body></html>`;
}

export function createWidgetIframeBridge(target: Window = window): {
    create(source: string, callbacks: WidgetBridgeCallbacks, tokens?: Record<string, string>): RuntimeRegistration;
    destroy(registration: RuntimeRegistration): void;
    dispose(): void;
    size(): number;
} {
    const runtimes = new Map<MessageEventSource, RuntimeRegistration>();
    const onMessage = (event: MessageEvent) => {
        if (event.origin !== 'null' || !event.source || typeof event.data !== 'object' || event.data === null) return;
        const runtime = runtimes.get(event.source);
        if (!runtime || event.data.nonce !== runtime.nonce) return;
        if (event.data.type === 'jaw-diagram-resize') {
            const height = Number(event.data.height);
            if (Number.isFinite(height) && height >= 0) runtime.onResize(Math.min(2000, Math.max(60, height)));
        } else if (event.data.type === 'jaw-send-prompt') runtime.onSend?.(String(event.data.text ?? '').trim().slice(0, 500));
        else if (event.data.type === 'jaw-copy-text') runtime.onCopy?.(String(event.data.text ?? '').slice(0, 512));
    };
    target.addEventListener('message', onMessage);
    return {
        create(source, callbacks, tokens) {
            const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-scripts');
            iframe.setAttribute('aria-label', 'Interactive diagram widget');
            iframe.srcdoc = buildWidgetSrcdoc(source, nonce, tokens);
            const registration = { iframe, nonce, ...callbacks };
            iframe.addEventListener('load', () => { if (iframe.contentWindow) runtimes.set(iframe.contentWindow, registration); }, { once: true });
            return registration;
        },
        destroy(registration) {
            if (registration.iframe.contentWindow) runtimes.delete(registration.iframe.contentWindow);
            registration.iframe.remove();
        },
        dispose() { target.removeEventListener('message', onMessage); for (const runtime of runtimes.values()) runtime.iframe.remove(); runtimes.clear(); },
        size: () => runtimes.size,
    };
}
