/**
 * TUI theme tokens + color-capability ladder.
 * Colors aligned to public/manager/src/manager-tokens.css. Four tiers:
 * truecolor → ansi256 → ansi16 → mono, resolved from env/TTY. dark + light palettes.
 * Backward-compatible API (paint/fgToken/attr/colorLevel) — truecolor output is
 * byte-identical to the Phase-1 version.
 */
export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const ITALIC = '\x1b[3m';
export const UNDER = '\x1b[4m';

export type ColorLevel = 'truecolor' | 'ansi256' | 'ansi16' | 'mono';
export type ThemeName = 'dark' | 'light';

/** Pure capability resolution (testable). Order matches doc 14 §3. */
export function resolveColorLevel(env: Record<string, string | undefined>, isTTY: boolean): ColorLevel {
    if (env['NO_COLOR'] != null) return 'mono';
    if (env['CLICOLOR'] === '0') return 'mono';
    const fc = env['FORCE_COLOR'];
    if (fc === '0') return 'mono';
    if (fc === '1') return 'ansi16';
    if (fc === '2') return 'ansi256';
    if (fc === '3' || fc === 'true') return 'truecolor';
    if (!isTTY) return 'mono';
    if (env['TERM'] === 'dumb') return 'mono';
    const ct = env['COLORTERM'];
    if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
    if (/256color/.test(env['TERM'] ?? '')) return 'ansi256';
    return 'ansi16';
}

/** Computed live so tests + runtime env changes are honored. */
export function colorLevel(): ColorLevel {
    return resolveColorLevel(process.env, Boolean(process.stdout.isTTY));
}

export function activeTheme(): ThemeName {
    return process.env['JAW_TUI_THEME'] === 'light' ? 'light' : 'dark';
}

const DARK = {
    'text.primary': '#e7edf5', 'text.muted': '#657283', 'accent': '#62a8f5',
    'heading': '#e7edf5', 'code.fence': '#657283', 'quote': '#9aa6b5', 'link': '#62a8f5',
    'status.error': '#f87171', 'diff.add': '#34d399', 'diff.del': '#f87171',
    'code.keyword': '#62a8f5', 'code.string': '#34d399', 'code.number': '#f5a524',
    'code.comment': '#657283', 'code.title': '#8fb8f7', 'code.type': '#5eead4',
    'code.built_in': '#f87171',
} as const;
const LIGHT: Record<keyof typeof DARK, string> = {
    'text.primary': '#111418', 'text.muted': '#6b7382', 'accent': '#1f6feb',
    'heading': '#111418', 'code.fence': '#6b7382', 'quote': '#4d5662', 'link': '#1f6feb',
    'status.error': '#b91c1c', 'diff.add': '#15803d', 'diff.del': '#b91c1c',
    'code.keyword': '#1f6feb', 'code.string': '#15803d', 'code.number': '#b45309',
    'code.comment': '#6b7382', 'code.title': '#155bbb', 'code.type': '#0f766e',
    'code.built_in': '#b91c1c',
} as const;
export type Token = keyof typeof DARK;

function rgb(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// hex → xterm-256 index (6×6×6 cube + grayscale ramp). Deterministic.
function to256([r, g, b]: [number, number, number]): number {
    if (r === g && g === b) {
        if (r < 8) return 16;
        if (r > 248) return 231;
        return 232 + Math.round(((r - 8) / 247) * 24);
    }
    const q = (v: number): number => Math.round((v / 255) * 5);
    return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

// Standard xterm 16-color palette (RGB) for nearest-match downgrade.
const ANSI16: ReadonlyArray<[number, number, number]> = [
    [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
    [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
function to16([r, g, b]: [number, number, number]): number {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < ANSI16.length; i++) {
        const p = ANSI16[i] ?? [0, 0, 0];
        const d = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2;
        if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
}

function fgEscape(hex: string, level: ColorLevel): string {
    const c = rgb(hex);
    if (level === 'truecolor') return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
    if (level === 'ansi256') return `\x1b[38;5;${to256(c)}m`;
    if (level === 'ansi16') {
        const idx = to16(c);
        return idx < 8 ? `\x1b[3${idx}m` : `\x1b[9${idx - 8}m`;
    }
    return '';
}

function tokenHex(t: Token): string {
    return activeTheme() === 'light' ? LIGHT[t] : DARK[t];
}

/** Raw fg escape for a token ('' in mono). highlight.ts manages its own RESET. */
export function fgToken(t: Token): string {
    const level = colorLevel();
    return level === 'mono' ? '' : fgEscape(tokenHex(t), level);
}

/** Wrap text in a token color (+ optional attributes). Mono keeps attributes only. */
export function paint(t: Token, s: string, attrs = ''): string {
    if (colorLevel() === 'mono') return attrs ? `${attrs}${s}${RESET}` : s;
    return `${attrs}${fgToken(t)}${s}${RESET}`;
}

/** Apply raw ANSI attributes (bold/italic/…) to text. */
export function attr(s: string, a: string): string {
    if (a === '') return s;
    return `${a}${s}${RESET}`;
}
