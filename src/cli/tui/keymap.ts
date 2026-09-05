export type KeyAction =
    | 'activity-history'
    | 'escape-alone'
    | 'option-enter'
    | 'arrow-up'
    | 'arrow-down'
    | 'arrow-left'
    | 'arrow-right'
    | 'word-left'
    | 'word-right'
    | 'page-up'
    | 'page-down'
    | 'home'
    | 'end'
    | 'tab'
    | 'enter'
    | 'backspace'
    | 'delete'
    | 'ctrl-c'
    | 'ctrl-u'
    | 'ctrl-k'
    | 'ctrl-o'
    | 'ctrl-w'
    | 'ctrl-y'
    | 'ctrl-x'
    | 'ctrl-e'
    | 'ctrl-_'
    | 'ctrl-d'
    | 'ctrl-r'
    | 'ctrl-l'
    | 'shift-tab'
    | 'printable'
    | 'other';

export function classifyKeyAction(key: string): KeyAction {
    if (key === '\x1b[17~') return 'activity-history';
    if (key === '\x1b') return 'escape-alone';
    if (key === '\x1b\r' || key === '\x1b\n') return 'option-enter';
    if (key === '\x1b[A' || key === '\x1bOA') return 'arrow-up';
    if (key === '\x1b[B' || key === '\x1bOB') return 'arrow-down';
    // word motions before plain left/right (ctrl/alt + arrow, and Alt+b/f)
    if (key === '\x1b[1;5D' || key === '\x1b[1;3D' || key === '\x1bb') return 'word-left';
    if (key === '\x1b[1;5C' || key === '\x1b[1;3C' || key === '\x1bf') return 'word-right';
    if (key === '\x1b[D' || key === '\x1bOD') return 'arrow-left';
    if (key === '\x1b[C' || key === '\x1bOC') return 'arrow-right';
    if (key === '\x1b[5~') return 'page-up';
    if (key === '\x1b[6~') return 'page-down';
    if (key === '\x1b[H' || key === '\x1b[1~' || key === '\x1bOH') return 'home';
    if (key === '\x1b[F' || key === '\x1b[4~' || key === '\x1bOF') return 'end';
    if (key === '\t') return 'tab';
    if (key === '\r' || key === '\n') return 'enter';
    if (key === '\x7f' || key === '\b') return 'backspace';
    if (key === '\x1b[3~') return 'delete';
    if (key === '\x03') return 'ctrl-c';
    if (key === '\x15') return 'ctrl-u';
    if (key === '\x0b') return 'ctrl-k';
    if (key === '\x0f') return 'ctrl-o';
    if (key === '\x17') return 'ctrl-w';
    if (key === '\x19') return 'ctrl-y';
    if (key === '\x18') return 'ctrl-x';
    if (key === '\x05') return 'ctrl-e';
    if (key === '\x1f') return 'ctrl-_';
    if (key === '\x04') return 'ctrl-d';
    if (key === '\x12') return 'ctrl-r';
    if (key === '\x0c') return 'ctrl-l';
    if (key === '\x1b[Z') return 'shift-tab';
    if (key.length > 0 && (key.charCodeAt(0) >= 32 || key.charCodeAt(0) > 127)) return 'printable';
    return 'other';
}

function isCsiFinal(ch: string): boolean {
    const code = ch.charCodeAt(0);
    return code >= 0x40 && code <= 0x7e;
}

export function splitKeyInput(input: string): string[] {
    const tokens: string[] = [];
    let i = 0;

    while (i < input.length) {
        const ch = input[i]!;

        if (ch === '\x1b') {
            const next = input[i + 1];
            if (next === '[') {
                let end = i + 2;
                while (end < input.length && !isCsiFinal(input[end]!)) end++;
                if (end < input.length) {
                    tokens.push(input.slice(i, end + 1));
                    i = end + 1;
                    continue;
                }
                tokens.push(input.slice(i));
                break;
            }
            if (next === 'O' && i + 2 < input.length) {
                tokens.push(input.slice(i, i + 3));
                i += 3;
                continue;
            }
            if (next) {
                tokens.push(input.slice(i, i + 2));
                i += 2;
                continue;
            }
            tokens.push(ch);
            i++;
            continue;
        }

        const codePoint = input.codePointAt(i);
        if (codePoint === undefined) break;
        const token = String.fromCodePoint(codePoint);
        tokens.push(token);
        i += token.length;
    }

    return tokens;
}
