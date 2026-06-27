/**
 * jawcode TUI Component bridge — thin import layer over pre-built bundles.
 * Tier 1: jawcode-tui-bundle.mjs (basic components: Box, Text, Markdown, etc.)
 * Tier 2: jawcode-interactive-bundle.mjs (InteractiveMode components: Welcome, StatusLine, etc.)
 */

// @strict-allow-any(jawcode bundled ESM module surface is loaded dynamically)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _tui: any = null;
// @strict-allow-any(jawcode bundled ESM module surface is loaded dynamically)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _interactive: any = null;
let _initialized = false;

/**
 * Raised when the pre-built jawcode TUI bundles are absent from this build —
 * e.g. an npm release published without the generated `dist/src/lib/tui/*.mjs`
 * artifacts (see scripts/atomic-build.sh, which only copies them when present).
 * Callers can catch this and fall back to `--simple` line mode instead of
 * crashing with a raw ERR_MODULE_NOT_FOUND stack trace.
 */
export class JawcodeBundleMissingError extends Error {
    readonly code = 'JAWCODE_BUNDLE_MISSING';
    constructor(cause?: unknown) {
        super(
            'jawcode TUI assets are missing from this build (dist/src/lib/tui/*.mjs were not bundled). '
            + 'Reinstall a complete release, or run `jaw chat --simple` for line mode.',
            cause === undefined ? undefined : { cause },
        );
        this.name = 'JawcodeBundleMissingError';
    }
}

function isModuleNotFound(err: unknown): boolean {
    return !!err && typeof err === 'object'
        && (err as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND';
}

export async function initJawcodeTui(): Promise<void> {
    if (_initialized) return;
    try {
        await import('../../lib/tui/bun-shim.mjs');
        _tui = await import('../../lib/tui/jawcode-tui-bundle.mjs');
    } catch (err) {
        // Distinguish a missing bundle (broken/partial package) from genuine
        // runtime errors so the caller can degrade gracefully to line mode.
        if (isModuleNotFound(err)) throw new JawcodeBundleMissingError(err);
        throw err;
    }
    try {
        _interactive = await import('../../lib/tui/jawcode-interactive-bundle.mjs');
        await _interactive.initTheme?.(false);
    } catch {
        _interactive = { theme: {} };
    }
    _initialized = true;
}

function ensureInit(): void {
    if (!_initialized) throw new Error('Call initJawcodeTui() before using jawcode render functions');
}

export function isInitialized(): boolean { return _initialized; }
// @strict-allow-any(jawcode bundled ESM module surface is loaded dynamically)
export function getTui(): any { ensureInit(); return _tui; }
// @strict-allow-any(jawcode bundled ESM module surface is loaded dynamically)
export function getInteractive(): any { ensureInit(); return _interactive; }

type MarkdownThemeFn = (text: string) => string;
type InteractiveThemeLike = {
    fg?: (color: string, text: string) => string;
    bold?: MarkdownThemeFn;
    italic?: MarkdownThemeFn;
    underline?: MarkdownThemeFn;
};

function asThemeLike(value: unknown): InteractiveThemeLike {
    if (!value || typeof value !== 'object') return {};
    return value as InteractiveThemeLike;
}

function buildMarkdownTheme(): Record<string, unknown> {
    const theme = _interactive?.theme;
    const themeLike = asThemeLike(theme);
    const fg = typeof themeLike.fg === 'function'
        ? (color: string, text: string) => themeLike.fg!(color, text)
        : (_color: string, text: string) => text;
    const bold = typeof themeLike.bold === 'function' ? themeLike.bold : (text: string) => text;
    const italic = typeof themeLike.italic === 'function' ? themeLike.italic : (text: string) => text;
    const underline = typeof themeLike.underline === 'function' ? themeLike.underline : (text: string) => text;
    return {
        heading: (t: string) => fg('mdHeading', t),
        link: (t: string) => fg('mdLink', t),
        linkUrl: (t: string) => fg('mdLinkUrl', t),
        code: (t: string) => fg('mdCode', t),
        codeBlock: (t: string) => fg('mdCodeBlock', t),
        codeBlockBorder: (t: string) => fg('mdCodeBlockBorder', t),
        quote: (t: string) => fg('mdQuote', t),
        quoteBorder: (t: string) => fg('mdQuoteBorder', t),
        hr: (t: string) => fg('mdHr', t),
        listBullet: (t: string) => fg('mdListBullet', t),
        bold,
        italic,
        underline,
        strikethrough: (t: string) => `\x1b[9m${t}\x1b[29m`,
        symbols: {
            quoteBorder: '│',
            hrChar: '─',
            table: {
                horizontal: '─',
                vertical: '│',
                topLeft: '┌',
                topRight: '┐',
                bottomLeft: '└',
                bottomRight: '┘',
                teeDown: '┬',
                teeUp: '┴',
                teeLeft: '┤',
                teeRight: '├',
                cross: '┼',
            },
        },
    };
}

export function renderMarkdownJawcode(text: string, width: number): string[] {
    ensureInit();
    const mdTheme = buildMarkdownTheme();
    const md = new _tui.Markdown(text, 1, 0, mdTheme);
    return md.render(width) as string[];
}

export function renderTextBox(_title: string, lines: string[], width: number): string[] {
    ensureInit();
    const box = new _tui.Box(1, 0);
    for (const line of lines) {
        const t = new _tui.Text(line, 0, 0);
        box.addChild(t);
    }
    return box.render(width) as string[];
}

export function getVisibleWidth(str: string): number {
    ensureInit();
    return _tui.visibleWidth(str) as number;
}
