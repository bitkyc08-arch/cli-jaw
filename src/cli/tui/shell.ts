import type { PaneState } from './panes.js';

function getRows(): number {
    return process.stdout.rows || 24;
}

export interface PaneRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ShellLayout {
    columns: number;
    rows: number;
    transcript: PaneRect;
    composer: PaneRect;
    footerDividerRow: number;
    footerRow: number;
    auxPanel: PaneRect | null;
}

export function resolveShellLayout(
    columns = process.stdout.columns || 80,
    rows = getRows(),
    paneState?: Pick<PaneState, 'openPanel' | 'preferredWidth' | 'side'>,
): ShellLayout {
    const footerDividerRow = Math.max(1, rows - 1);
    const footerRow = Math.max(1, rows);
    const transcriptHeight = Math.max(1, rows - 2);
    const requestedWidth = paneState?.preferredWidth || 32;
    const canShowAux = !!paneState?.openPanel && columns >= 80;
    const auxWidth = canShowAux ? Math.max(24, Math.min(requestedWidth, Math.floor(columns * 0.4))) : 0;
    const transcriptWidth = canShowAux ? Math.max(24, columns - auxWidth - 1) : columns;
    const auxX = paneState?.side === 'left' ? 1 : transcriptWidth + 2;
    const transcriptX = paneState?.side === 'left' && canShowAux ? auxWidth + 2 : 1;

    return {
        columns,
        rows,
        transcript: {
            x: transcriptX,
            y: 1,
            width: transcriptWidth,
            height: transcriptHeight,
        },
        composer: {
            x: transcriptX,
            y: transcriptHeight,
            width: transcriptWidth,
            height: 1,
        },
        footerDividerRow,
        footerRow,
        auxPanel: canShowAux
            ? {
                x: auxX,
                y: 1,
                width: auxWidth,
                height: transcriptHeight,
            }
            : null,
    };
}

export function setupScrollRegion(footer: string, dividerLine: string, layout = resolveShellLayout()): void {
    process.stdout.write(`\x1b[1;${layout.transcript.y + layout.transcript.height - 1}r`);
    process.stdout.write(`\x1b[${layout.footerDividerRow};1H\x1b[2K${dividerLine}`);
    process.stdout.write(`\x1b[${layout.footerRow};1H\x1b[2K${footer}`);
    process.stdout.write(`\x1b[${layout.composer.y};1H`);
}

export function cleanupScrollRegion(layout = resolveShellLayout()): void {
    process.stdout.write(`\x1b[1;${layout.rows}r`);
    process.stdout.write(`\x1b[${layout.rows};1H\n`);
}

export function ensureSpaceBelow(lineCount: number): void {
    if (lineCount <= 0) return;
    for (let i = 0; i < lineCount; i++) process.stdout.write('\n');
    process.stdout.write(`\x1b[${lineCount}A`);
}
