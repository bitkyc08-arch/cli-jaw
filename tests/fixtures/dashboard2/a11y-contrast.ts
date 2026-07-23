import type { Page } from 'playwright-core';

export interface ContrastEvidence {
    theme: 'dark' | 'light';
    token: string;
    foreground: string;
    surface: string;
    background: string;
    compositedBackground: string;
    ratio: number;
    threshold: number;
    usage: 'normal-text' | 'ui';
    pass: boolean;
}

export async function collectContrastTable(page: Page, theme: 'dark' | 'light'): Promise<ContrastEvidence[]> {
    return page.evaluate((activeTheme) => {
        type Rgba = { r: number; g: number; b: number; a: number };
        const probe = document.createElement('span');
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        document.body.append(probe);
        const resolved = (value: string, property: 'color' | 'backgroundColor'): string => {
            probe.style[property] = value;
            return getComputedStyle(probe)[property];
        };
        const parse = (value: string): Rgba => {
            const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
            return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
        };
        const composite = (front: Rgba, back: Rgba): Rgba => ({
            r: front.r * front.a + back.r * (1 - front.a),
            g: front.g * front.a + back.g * (1 - front.a),
            b: front.b * front.a + back.b * (1 - front.a),
            a: 1,
        });
        const rgb = (value: Rgba): string => `rgb(${Math.round(value.r)}, ${Math.round(value.g)}, ${Math.round(value.b)})`;
        const luminance = (value: Rgba): number => {
            const channel = (input: number): number => {
                const normalized = input / 255;
                return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * channel(value.r) + 0.7152 * channel(value.g) + 0.0722 * channel(value.b);
        };
        const ratio = (left: Rgba, right: Rgba): number => {
            const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
            return (light! + 0.05) / (dark! + 0.05);
        };
        const root = getComputedStyle(document.documentElement);
        const surfaces = new Map<string, string>([
            ['bg', root.getPropertyValue('--bg').trim()],
            ['surface', root.getPropertyValue('--surface').trim()],
            ['accent-soft-on-surface', root.getPropertyValue('--accent-soft').trim()],
            ['pos-dim-on-surface', root.getPropertyValue('--pos-dim').trim()],
        ]);
        const sidebarGradient = getComputedStyle(document.querySelector('.d2-sidebar')!, '::before').backgroundImage;
        const sidebarStops = [...sidebarGradient.matchAll(/rgba?\([^)]*\)/g)].map(match => parse(match[0]));
        const rootBackground = parse(resolved('var(--bg)', 'backgroundColor'));
        const rows: Array<{ token: string; surface: string; threshold: number; usage: 'normal-text' | 'ui' }> = [
            { token: '--text-3', surface: 'bg', threshold: 4.5, usage: 'normal-text' },
            { token: '--text-3', surface: 'surface', threshold: 4.5, usage: 'normal-text' },
            { token: '--text-3', surface: 'sidebar-worst-stop', threshold: 4.5, usage: 'normal-text' },
            { token: '--text-4', surface: 'bg', threshold: 4.5, usage: 'normal-text' },
            { token: '--text-4', surface: 'surface', threshold: 4.5, usage: 'normal-text' },
            { token: '--text-4', surface: 'sidebar-worst-stop', threshold: 4.5, usage: 'normal-text' },
            { token: '--positive', surface: 'surface', threshold: 4.5, usage: 'normal-text' },
            { token: '--positive', surface: 'pos-dim-on-surface', threshold: 4.5, usage: 'normal-text' },
            { token: '--warn', surface: 'surface', threshold: 4.5, usage: 'normal-text' },
            { token: '--warn-text', surface: 'surface', threshold: 4.5, usage: 'normal-text' },
            { token: '--danger', surface: 'surface', threshold: 4.5, usage: 'normal-text' },
            { token: '--accent', surface: 'accent-soft-on-surface', threshold: 3, usage: 'ui' },
        ];
        const baseSurface = parse(resolved('var(--surface)', 'backgroundColor'));
        const output = rows.map(row => {
            const foreground = resolved(`var(${row.token})`, 'color');
            const foregroundRgba = parse(foreground);
            let background: string;
            let composited: Rgba;
            if (row.surface === 'sidebar-worst-stop') {
                const candidates = sidebarStops.map(stop => composite(stop, rootBackground));
                composited = candidates.sort((left, right) => ratio(foregroundRgba, left) - ratio(foregroundRgba, right))[0]!;
                background = sidebarGradient;
            } else {
                background = resolved(surfaces.get(row.surface)!, 'backgroundColor');
                const parsedBackground = parse(background);
                composited = parsedBackground.a < 1 ? composite(parsedBackground, baseSurface) : parsedBackground;
            }
            const measured = Math.round(ratio(foregroundRgba, composited) * 100) / 100;
            return {
                theme: activeTheme, token: row.token, foreground, surface: row.surface, background,
                compositedBackground: rgb(composited), ratio: measured, threshold: row.threshold,
                usage: row.usage, pass: measured >= row.threshold,
            };
        });
        probe.remove();
        return output;
    }, theme);
}
