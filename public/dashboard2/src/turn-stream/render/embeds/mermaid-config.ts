export type ResolvedTheme = 'dark' | 'light';

const FALLBACK = {
    dark: { bg: '#1a1a1d', text: '#f0f0f2', muted: '#b0b0b8', border: '#4a4a52', accent: '#6ea8fe' },
    light: { bg: '#ffffff', text: '#18202a', muted: '#657180', border: '#9ba7b5', accent: '#0969da' },
} as const;

function resolvedToken(name: string, fallback: string): string {
    if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function getMermaidThemeVariables(resolvedTheme: ResolvedTheme): Record<string, string> {
    const fallback = FALLBACK[resolvedTheme];
    const bg = resolvedToken('--surface', fallback.bg);
    const text = resolvedToken('--text', fallback.text);
    const muted = resolvedToken('--text-3', fallback.muted);
    const border = resolvedToken('--border-h', fallback.border);
    const accent = resolvedToken('--accent', fallback.accent);
    return {
        primaryColor: bg, primaryTextColor: text, primaryBorderColor: border, lineColor: muted,
        secondaryColor: accent, tertiaryColor: resolvedToken('--surface-h', bg), background: 'transparent',
        mainBkg: bg, nodeBorder: border, clusterBkg: bg, clusterBorder: border,
        titleColor: text, edgeLabelBackground: bg,
        cScale0: resolvedToken('--mermaid-scale-0', resolvedTheme === 'light' ? '#dbeafe' : '#1e3a5f'),
        cScale1: resolvedToken('--mermaid-scale-1', resolvedTheme === 'light' ? '#ede9fe' : '#3b1f5e'),
        cScale2: resolvedToken('--mermaid-scale-2', resolvedTheme === 'light' ? '#dcfce7' : '#14532d'),
        cScale3: resolvedToken('--mermaid-scale-3', resolvedTheme === 'light' ? '#fef3c7' : '#451a03'),
        cScale4: resolvedToken('--mermaid-scale-4', resolvedTheme === 'light' ? '#cffafe' : '#083344'),
        cScale5: resolvedToken('--mermaid-scale-5', resolvedTheme === 'light' ? '#fce7f3' : '#500724'),
        cScale6: resolvedToken('--mermaid-scale-6', resolvedTheme === 'light' ? '#ffedd5' : '#431407'),
        cScale7: resolvedToken('--mermaid-scale-7', resolvedTheme === 'light' ? '#f1f5f9' : '#1e293b'),
        cScaleLabel0: resolvedToken('--mermaid-scale-label-0', resolvedTheme === 'light' ? '#1e40af' : '#93c5fd'),
        cScaleLabel1: resolvedToken('--mermaid-scale-label-1', resolvedTheme === 'light' ? '#5b21b6' : '#c4b5fd'),
        cScaleLabel2: resolvedToken('--mermaid-scale-label-2', resolvedTheme === 'light' ? '#15803d' : '#86efac'),
        cScaleLabel3: resolvedToken('--mermaid-scale-label-3', resolvedTheme === 'light' ? '#92400e' : '#fcd34d'),
        cScaleLabel4: resolvedToken('--mermaid-scale-label-4', resolvedTheme === 'light' ? '#155e75' : '#67e8f9'),
        cScaleLabel5: resolvedToken('--mermaid-scale-label-5', resolvedTheme === 'light' ? '#9d174d' : '#f9a8d4'),
        cScaleLabel6: resolvedToken('--mermaid-scale-label-6', resolvedTheme === 'light' ? '#9a3412' : '#fdba74'),
        cScaleLabel7: resolvedToken('--mermaid-scale-label-7', resolvedTheme === 'light' ? '#334155' : '#94a3b8'),
    };
}

export function getMermaidInitConfig(resolvedTheme: ResolvedTheme): Record<string, unknown> {
    return {
        startOnLoad: false, theme: 'base', htmlLabels: false,
        securityLevel: 'strict', suppressErrorRendering: true,
        themeVariables: getMermaidThemeVariables(resolvedTheme),
        gantt: { useMaxWidth: false, useWidth: 800 },
    };
}

export const WIDE_MERMAID_TYPES = new Set([
    'gantt', 'sequencediagram', 'timeline', 'sankey', 'sankey-beta', 'architecture-beta',
    'block', 'block-beta', 'xychart', 'xychart-beta', 'packet', 'kanban', 'radar-beta',
    'treemap-beta', 'swimlane-beta', 'venn-beta', 'eventmodeling', 'mindmap',
]);

export function detectMermaidDiagramType(code: string): string | null {
    for (const rawLine of code.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('%%') || line.startsWith('---')) continue;
        return line.split(/\s+/)[0].toLowerCase();
    }
    return null;
}

export function isWideMermaidDiagram(code: string): boolean {
    const type = detectMermaidDiagramType(code);
    return type !== null && WIDE_MERMAID_TYPES.has(type);
}
