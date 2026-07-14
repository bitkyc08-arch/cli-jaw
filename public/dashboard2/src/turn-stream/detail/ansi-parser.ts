export interface AnsiStyleRun {
    text: string;
    fg?: string;
    bg?: string;
    bold?: boolean;
    dim?: boolean;
    italic?: boolean;
    underline?: boolean;
}

export interface AnsiParseResult {
    tokens: AnsiStyleRun[];
    state: string | null;
    pending: string;
}

type Style = Omit<AnsiStyleRun, 'text'>;
const COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

function decodeState(seed: string | null): Style {
    if (!seed) return {};
    const match = seed.match(/^\x1b\[([0-9;]*)m$/);
    return match ? applySgr({}, match[1] ?? '') : {};
}

function applySgr(previous: Style, body: string): Style {
    let style = { ...previous };
    const codes = (body || '0').split(';').map(value => Number(value));
    for (let i = 0; i < codes.length; i += 1) {
        const code = codes[i] ?? 0;
        if (code === 0) style = {};
        else if (code === 1) style.bold = true;
        else if (code === 2) style.dim = true;
        else if (code === 3) style.italic = true;
        else if (code === 4) style.underline = true;
        else if (code === 22) { delete style.bold; delete style.dim; }
        else if (code === 23) delete style.italic;
        else if (code === 24) delete style.underline;
        else if (code >= 30 && code <= 37) style.fg = COLORS[code - 30];
        else if (code === 39) delete style.fg;
        else if (code >= 40 && code <= 47) style.bg = COLORS[code - 40];
        else if (code === 49) delete style.bg;
        else if ((code === 38 || code === 48) && codes[i + 1] === 5 && Number.isFinite(codes[i + 2])) {
            style[code === 38 ? 'fg' : 'bg'] = `ansi-${codes[i + 2]}`;
            i += 2;
        }
    }
    return style;
}

function encodeState(style: Style): string | null {
    const codes: string[] = [];
    if (style.bold) codes.push('1');
    if (style.dim) codes.push('2');
    if (style.italic) codes.push('3');
    if (style.underline) codes.push('4');
    const fg = style.fg ? COLORS.indexOf(style.fg) : -1;
    const bg = style.bg ? COLORS.indexOf(style.bg) : -1;
    if (fg >= 0) codes.push(String(30 + fg));
    else if (style.fg?.startsWith('ansi-')) codes.push('38', '5', style.fg.slice(5));
    if (bg >= 0) codes.push(String(40 + bg));
    else if (style.bg?.startsWith('ansi-')) codes.push('48', '5', style.bg.slice(5));
    return codes.length ? `\x1b[${codes.join(';')}m` : null;
}

export function parseAnsiChunk(text: string, ansiStateBefore: string | null = null, pending = ''): AnsiParseResult {
    const input = pending + text;
    const tokens: AnsiStyleRun[] = [];
    let style = decodeState(ansiStateBefore);
    let plain = '';
    const flush = () => { if (plain) { tokens.push({ text: plain, ...style }); plain = ''; } };
    let index = 0;
    while (index < input.length) {
        if (input.charCodeAt(index) !== 0x1b) { plain += input[index++]; continue; }
        flush();
        if (index + 1 >= input.length) return { tokens, state: encodeState(style), pending: input.slice(index) };
        const marker = input[index + 1];
        if (marker === ']') {
            const bell = input.indexOf('\x07', index + 2);
            const st = input.indexOf('\x1b\\', index + 2);
            const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
            if (end < 0) return { tokens, state: encodeState(style), pending: input.slice(index) };
            index = end + (input[end] === '\x07' ? 1 : 2);
            continue;
        }
        if (marker === '[') {
            let end = index + 2;
            while (end < input.length && !(input.charCodeAt(end) >= 0x40 && input.charCodeAt(end) <= 0x7e)) end += 1;
            if (end >= input.length) return { tokens, state: encodeState(style), pending: input.slice(index) };
            if (input[end] === 'm') style = applySgr(style, input.slice(index + 2, end));
            index = end + 1;
            continue;
        }
        index += 2;
    }
    flush();
    return { tokens, state: encodeState(style), pending: '' };
}
