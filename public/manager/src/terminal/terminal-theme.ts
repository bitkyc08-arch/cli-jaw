import type { ITheme } from '@xterm/xterm';

// xterm cannot consume manager-tokens.css's oklch/color-mix expressions.
// Fixed sRGB projection: surface-canvas / text-primary / accent, with the
// selection overlay composited over that canvas (40% dark / 30% light).
// Accent sources: oklch(0.571 0.21 264) / oklch(0.488 0.217 264).
// Light canvas: oklch(99.2% 0 0); text: gray-800. ANSI colors belong here.
const dark = {
    background: '#0a0a0a', foreground: '#f1f3f7', cursor: '#346bf1',
    cursorAccent: '#0a0a0a', selectionBackground: '#1b3166',
    black: '#18181b', brightBlack: '#71717a', red: '#f87171', brightRed: '#fca5a5',
    green: '#4ade80', brightGreen: '#86efac', yellow: '#facc15', brightYellow: '#fde047',
    blue: '#60a5fa', brightBlue: '#93c5fd', magenta: '#e879f9', brightMagenta: '#f0abfc',
    cyan: '#22d3ee', brightCyan: '#67e8f9', white: '#d4d4d8', brightWhite: '#fafafa',
} satisfies ITheme;
const light = {
    background: '#fcfcfc', foreground: '#27272a', cursor: '#1b4ed8',
    cursorAccent: '#fcfcfc', selectionBackground: '#b8c8f1',
    black: '#18181b', brightBlack: '#52525b', red: '#b91c1c', brightRed: '#991b1b',
    green: '#15803d', brightGreen: '#166534', yellow: '#854d0e', brightYellow: '#713f12',
    blue: '#1d4ed8', brightBlue: '#1e40af', magenta: '#a21caf', brightMagenta: '#86198f',
    cyan: '#0e7490', brightCyan: '#155e75', white: '#71717a', brightWhite: '#52525b',
} satisfies ITheme;

export function resolveTerminalTheme(documentTheme: string | null | undefined, prefersLight: boolean) {
    return { ...(documentTheme === 'light' || (documentTheme === 'auto' && prefersLight) ? light : dark) };
}
