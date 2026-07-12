// ── Shared Mermaid configuration and type detection ──
// Extracted from mermaid.ts so Notes (MermaidBlock.tsx) can import
// config without pulling in the Chat DOM adapter, render queue, etc.

export function getMermaidThemeVars() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    return isLight ? {
        primaryColor: '#e2e8f0',
        primaryTextColor: '#1a202c',
        primaryBorderColor: '#a0aec0',
        lineColor: '#718096',
        secondaryColor: '#ebf8ff',
        tertiaryColor: '#f7fafc',
        background: 'transparent',
        mainBkg: '#e2e8f0',
        nodeBorder: '#a0aec0',
        clusterBkg: '#f7fafc',
        clusterBorder: '#cbd5e0',
        titleColor: '#1a202c',
        edgeLabelBackground: '#f7fafc',
        // Mindmap branch section colors (light)
        cScale0: '#dbeafe', cScale1: '#ede9fe', cScale2: '#dcfce7', cScale3: '#fef3c7',
        cScale4: '#cffafe', cScale5: '#fce7f3', cScale6: '#ffedd5', cScale7: '#f1f5f9',
        cScaleLabel0: '#1e40af', cScaleLabel1: '#5b21b6', cScaleLabel2: '#15803d',
        cScaleLabel3: '#92400e', cScaleLabel4: '#155e75', cScaleLabel5: '#9d174d',
        cScaleLabel6: '#9a3412', cScaleLabel7: '#334155',
    } : {
        primaryColor: '#2d3748',
        primaryTextColor: '#e2e8f0',
        primaryBorderColor: '#4a5568',
        lineColor: '#718096',
        secondaryColor: '#1a365d',
        tertiaryColor: '#1a202c',
        background: 'transparent',
        mainBkg: '#2d3748',
        nodeBorder: '#4a5568',
        clusterBkg: '#1a202c',
        clusterBorder: '#2d3748',
        titleColor: '#e2e8f0',
        edgeLabelBackground: '#1a202c',
        // Mindmap branch section colors (dark) — low-opacity tints
        cScale0: '#1e3a5f', cScale1: '#3b1f5e', cScale2: '#14532d', cScale3: '#451a03',
        cScale4: '#083344', cScale5: '#500724', cScale6: '#431407', cScale7: '#1e293b',
        cScaleLabel0: '#93c5fd', cScaleLabel1: '#c4b5fd', cScaleLabel2: '#86efac',
        cScaleLabel3: '#fcd34d', cScaleLabel4: '#67e8f9', cScaleLabel5: '#f9a8d4',
        cScaleLabel6: '#fdba74', cScaleLabel7: '#94a3b8',
    };
}

export function getMermaidInitConfig() {
    return {
        startOnLoad: false,
        theme: 'base' as const,
        htmlLabels: false,
        themeVariables: getMermaidThemeVars(),
        securityLevel: 'strict' as const,
        suppressErrorRendering: true,
        gantt: { useMaxWidth: false, useWidth: 800 },
    };
}

export const WIDE_MERMAID_TYPES = new Set([
    'gantt',
    'sequencediagram',
    'timeline',
    'sankey',
    'sankey-beta',
    'architecture-beta',
    'block',
    'block-beta',
    'xychart',
    'xychart-beta',
    'packet',
    'kanban',
    'radar-beta',
    'treemap-beta',
    'swimlane-beta',
    'venn-beta',
    'eventmodeling',
    'mindmap',
]);

export function detectMermaidDiagramType(code: string): string | null {
    for (const rawLine of code.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('%%')) continue;
        if (line.startsWith('---')) continue;
        return line.split(/\s+/)[0].toLowerCase();
    }
    return null;
}

export function isWideMermaidDiagram(code: string): boolean {
    const type = detectMermaidDiagramType(code);
    return !!type && WIDE_MERMAID_TYPES.has(type);
}
