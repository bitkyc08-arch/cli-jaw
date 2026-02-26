/**
 * CDN Global Library Type Declarations
 *
 * These libraries are loaded via <script defer> in index.html and
 * exposed as window globals. They are NOT bundled by esbuild.
 *
 * ⚠️ These packages are NOT in package.json (CDN-only),
 *    so we define inline interfaces instead of import type.
 *
 * All interfaces MUST be inside `declare global` because this
 * file uses `export {}` (making it a module).
 */

declare global {
    // --- marked v14 ---
    interface MarkedOptions {
        renderer?: Record<string, unknown>;
        gfm?: boolean;
        breaks?: boolean;
        pedantic?: boolean;
        async?: boolean;
    }

    interface MarkedToken {
        type: string;
        raw: string;
        text?: string;
        tokens?: MarkedToken[];
        href?: string;
        title?: string;
        lang?: string;
        items?: MarkedToken[];
        depth?: number;
        ordered?: boolean;
        header?: MarkedToken[][];
        rows?: MarkedToken[][];
    }

    interface MarkedGlobal {
        parse(src: string, options?: MarkedOptions): string | Promise<string>;
        use(...extensions: Record<string, unknown>[]): void;
        setOptions(options: MarkedOptions): void;
        Renderer: new () => Record<string, unknown>;
    }

    // --- highlight.js v11 ---
    interface HLJSResult {
        value: string;
        language?: string;
        relevance: number;
        top?: unknown;
    }

    interface HLJSGlobal {
        highlightAll(): void;
        highlightElement(element: HTMLElement): void;
        highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): HLJSResult;
        highlightAuto(code: string): HLJSResult;
        getLanguage(name: string): unknown;
        listLanguages(): string[];
        registerLanguage(name: string, lang: unknown): void;
    }

    // --- KaTeX ---
    interface KaTeXGlobal {
        renderToString(tex: string, options?: {
            displayMode?: boolean;
            throwOnError?: boolean;
            output?: string;
            macros?: Record<string, string>;
        }): string;
        render(tex: string, element: HTMLElement, options?: Record<string, unknown>): void;
    }

    // --- Mermaid v11 ---
    interface MermaidConfig {
        startOnLoad?: boolean;
        theme?: string;
        securityLevel?: 'strict' | 'loose' | 'antiscript' | 'sandbox';
        [key: string]: unknown;
    }

    interface MermaidRenderResult {
        svg: string;
        bindFunctions?: (element: Element) => void;
    }

    interface MermaidGlobal {
        initialize(config: MermaidConfig): void;
        run(config?: { querySelector?: string; nodes?: NodeListOf<Element> | Element[] }): Promise<void>;
        render(id: string, definition: string, container?: Element): Promise<MermaidRenderResult>;
        contentLoaded(): void;
    }

    // --- DOMPurify v3 ---
    interface DOMPurifyConfig {
        ALLOWED_TAGS?: string[];
        ALLOWED_ATTR?: string[];
        FORBID_TAGS?: string[];
        FORBID_ATTR?: string[];
        ADD_TAGS?: string[];
        ADD_ATTR?: string[];
        RETURN_DOM?: boolean;
        RETURN_DOM_FRAGMENT?: boolean;
        RETURN_DOM_IMPORT?: boolean;
        WHOLE_DOCUMENT?: boolean;
        [key: string]: unknown;
    }

    interface DOMPurifyGlobal {
        sanitize(dirty: string | Node, config?: DOMPurifyConfig): string;
        isSupported: boolean;
        setConfig(config: DOMPurifyConfig): void;
        addHook(hook: string, cb: (node: Element, data: unknown, config: DOMPurifyConfig) => void): void;
        removeHook(hook: string): void;
    }

    // --- Window extension ---
    interface Window {
        marked: MarkedGlobal;
        hljs: HLJSGlobal;
        katex: KaTeXGlobal;
        mermaid: MermaidGlobal;
        DOMPurify: DOMPurifyGlobal;
    }

    // Allow direct access without window. prefix
    const marked: MarkedGlobal;
    const hljs: HLJSGlobal;
    const katex: KaTeXGlobal;
    const mermaid: MermaidGlobal;
    const DOMPurify: DOMPurifyGlobal;
}

export { };
