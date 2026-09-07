import { sharkIcon } from './icons.js';
import { clipTextToCols, visualWidth } from './renderers.js';

const SHARK_ART = [
    '            ▄▄▄▄▄▄            ',
    '         ▄▀░░░░░░░▀▄          ',
    '       ▄▀░░░░░░░░░░░▀▄       ',
    '      █░░░░░░░░░░░░░░░█      ',
    '     █░░░●░░░░░░░●░░░░░█     ',
    '    █░░░░░░░▄▄▄░░░░░░░░░█    ',
    '   █░░░░░░░░░▀▀░░░░░░░░░░█   ',
    '  █░░░░╱░░░░░░░░░░░╲░░░░░░█  ',
    ' █░░░╱░╱░░░░░░░░░╲░╲░░░░░░█ ',
    '█░░░╱░╱░░░░░░░░░░░╲░╲░░░░░░█',
    '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
    '≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈',
];

const BLUE_GRADIENT: ReadonlyArray<readonly [number, number, number]> = [
    [15, 42, 90],
    [30, 64, 175],
    [59, 130, 246],
    [96, 165, 250],
    [147, 197, 253],
];

function gradientLine(line: string, row: number, totalRows: number, shinePos?: number): string {
    const lineLen = line.replace(/\x1b\[[0-9;]*m/g, '').length;
    if (lineLen === 0) return '';

    const chars: string[] = [];
    let ci = 0;
    for (const ch of line) {
        const ty = totalRows > 1 ? row / (totalRows - 1) : 0.5;
        const tx = lineLen > 1 ? ci / (lineLen - 1) : 0.5;
        const t = ty * 0.7 + tx * 0.3;
        const stopIdx = Math.min(t, 1) * (BLUE_GRADIENT.length - 1);
        const lo = Math.floor(stopIdx);
        const hi = Math.min(lo + 1, BLUE_GRADIENT.length - 1);
        const frac = stopIdx - lo;
        const c0 = BLUE_GRADIENT[lo]!;
        const c1 = BLUE_GRADIENT[hi]!;
        let r = Math.round(c0[0] + (c1[0] - c0[0]) * frac);
        let g = Math.round(c0[1] + (c1[1] - c0[1]) * frac);
        let b = Math.round(c0[2] + (c1[2] - c0[2]) * frac);

        if (shinePos !== undefined) {
            const diag = (tx + ty) / 2;
            const dist = Math.abs(diag - shinePos);
            if (dist < 0.2) {
                const boost = (1 - dist / 0.2) * 0.6;
                r = Math.min(255, Math.round(r + (255 - r) * boost));
                g = Math.min(255, Math.round(g + (255 - g) * boost));
                b = Math.min(255, Math.round(b + (255 - b) * boost));
            }
        }

        chars.push(`\x1b[38;2;${r};${g};${b}m${ch}`);
        if (ch.match(/[^\x1b]/)) ci++;
    }
    chars.push('\x1b[0m');
    return chars.join('');
}

function fitAnsiCell(text: string, width: number): string {
    const safeWidth = Math.max(0, width);
    if (safeWidth === 0) return '';
    const clipped = clipTextToCols(text, safeWidth);
    return `${clipped}${' '.repeat(Math.max(0, safeWidth - visualWidth(clipped)))}`;
}

export function renderJawWelcome(opts: {
    version: string;
    model: string;
    engine: string;
    projectRoot?: string | undefined;
    port?: number | undefined;
    gitBranch?: string | undefined;
    recentSessions?: Array<{ label: string; ago: string }> | undefined;
    phase?: number | undefined;
}, width: number): string[] {
    const rows = process.stdout.rows || 24;
    const W = Math.min(width, 78);

    if (rows < 20) {
        const icon = sharkIcon();
        const BLUE = '\x1b[38;2;59;130;246m';
        const LTBLUE = '\x1b[38;2;96;165;250m';
        const MUTED = '\x1b[38;2;51;65;85m';
        const BOLD = '\x1b[1m';
        const RST = '\x1b[0m';
        const lines = [
            `${BLUE}${BOLD}${icon} jaw${RST} ${MUTED}v${opts.version}${RST}  ${MUTED}bite anything!${RST}`,
            `${LTBLUE}⬢${RST} ${opts.model}  ${MUTED}engine:${RST} ${LTBLUE}${opts.engine}${RST}`,
        ];
        if (opts.projectRoot) {
            const display = opts.projectRoot.replace(process.env['HOME'] || '', '~');
            lines.push(`${MUTED}📁 ${display}${opts.gitBranch ? `  ⴲ ${opts.gitBranch}` : ''}${opts.port ? `  :${opts.port}` : ''}${RST}`);
        }
        return lines;
    }
    const DIM = '\x1b[2m';
    const BOLD = '\x1b[1m';
    const RST = '\x1b[0m';
    const BLUE = '\x1b[38;2;59;130;246m';
    const LTBLUE = '\x1b[38;2;96;165;250m';
    const NAVY = '\x1b[38;2;30;64;175m';
    const MUTED = '\x1b[38;2;51;65;85m';

    const icon = sharkIcon();
    const borderH = '─';
    const bTL = '╭'; const bTR = '╮'; const bBL = '╰'; const bBR = '╯';
    const bV = '│';

    const innerW = W - 2;
    const titleText = ` ${icon} jaw v${opts.version} `;
    const titlePad = Math.max(0, innerW - visualWidth(titleText));
    const titleLeft = Math.floor(titlePad / 2);
    const titleRight = titlePad - titleLeft;

    const lines: string[] = [];

    lines.push(`${NAVY}${bTL}${borderH.repeat(titleLeft)}${LTBLUE}${titleText}${NAVY}${borderH.repeat(titleRight)}${bTR}${RST}`);

    const showRightPane = W >= 60;
    const contentGap = showRightPane ? 3 : 1;
    const availableContentW = Math.max(1, innerW - contentGap);
    const leftW = showRightPane ? Math.floor(availableContentW * 0.55) : availableContentW;
    const rightW = showRightPane ? Math.max(1, availableContentW - leftW) : 0;

    const leftLines: string[] = [
        `${BOLD}${BLUE}${icon} jaw${RST}`,
        `${DIM}${MUTED}bite anything!${RST}`,
        `${MUTED}v${opts.version}${RST}`,
        '',
    ];

    const shinePos = opts.phase !== undefined ? (opts.phase % 1.0) : undefined;
    for (let i = 0; i < SHARK_ART.length; i++) {
        leftLines.push(gradientLine(SHARK_ART[i]!, i, SHARK_ART.length, shinePos));
    }

    leftLines.push('');
    leftLines.push(`${BLUE}⬢${RST} ${LTBLUE}${opts.model}${RST}`);
    leftLines.push(`${MUTED}engine:${RST} ${BOLD}${LTBLUE}${opts.engine}${RST}`);

    const rightLines: string[] = [
        `${BOLD}${LTBLUE}Flow keys${RST}`,
        `${MUTED}/  ·  #  ·  !  ·  $  ·  ?${RST}`,
        `${MUTED}ctrl+l · shift+tab${RST}`,
        '',
    ];

    rightLines.push(`${BOLD}${LTBLUE}Project${RST}`);
    if (opts.projectRoot) {
        const display = opts.projectRoot.replace(process.env['HOME'] || '', '~');
        rightLines.push(`${MUTED}📁 ${display}${RST}`);
        if (opts.gitBranch) rightLines.push(`${MUTED}ⴲ ${opts.gitBranch}${RST}`);
    } else {
        rightLines.push(`${MUTED}(no project set)${RST}`);
    }
    if (opts.port) rightLines.push(`${MUTED}:${opts.port}${RST}`);
    rightLines.push('');

    rightLines.push(`${BOLD}${LTBLUE}Session trail${RST}`);
    if (opts.recentSessions && opts.recentSessions.length > 0) {
        for (const s of opts.recentSessions.slice(0, 3)) {
            rightLines.push(`${MUTED}▸ ${s.label} (${s.ago})${RST}`);
        }
    } else {
        rightLines.push(`${MUTED}No saved trails${RST}`);
    }
    rightLines.push('');
    rightLines.push(`${MUTED}/resume${RST}`);

    const mergeRows = showRightPane ? Math.max(leftLines.length, rightLines.length) : leftLines.length;
    for (let i = 0; i < mergeRows; i++) {
        const l = leftLines[i] || '';
        if (showRightPane) {
            const r = rightLines[i] || '';
            lines.push(`${NAVY}${bV}${RST} ${fitAnsiCell(l, leftW)}${NAVY}${bV}${RST} ${fitAnsiCell(r, rightW)}${NAVY}${bV}${RST}`);
        } else {
            lines.push(`${NAVY}${bV}${RST} ${fitAnsiCell(l, leftW)}${NAVY}${bV}${RST}`);
        }
    }

    lines.push(`${NAVY}${bBL}${borderH.repeat(innerW)}${bBR}${RST}`);

    return lines;
}

export async function playJawWelcomeIntro(
    opts: Parameters<typeof renderJawWelcome>[0],
    width: number,
    write: (line: string) => void,
): Promise<void> {
    const FRAMES = 16;
    const DURATION_MS = 1500;
    const interval = DURATION_MS / FRAMES;
    const lineCount = renderJawWelcome({ ...opts, phase: 0 }, width).length;

    for (let f = 0; f < FRAMES; f++) {
        const phase = f / FRAMES;
        const lines = renderJawWelcome({ ...opts, phase }, width);
        write(`\x1b[${lineCount}A`);
        for (const line of lines) write(line + '\n');
        await new Promise(r => setTimeout(r, interval));
    }
}
