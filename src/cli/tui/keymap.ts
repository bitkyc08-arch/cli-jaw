export type KeyAction =
    | 'escape-alone'
    | 'option-enter'
    | 'arrow-up'
    | 'arrow-down'
    | 'page-up'
    | 'page-down'
    | 'home'
    | 'end'
    | 'tab'
    | 'enter'
    | 'backspace'
    | 'ctrl-c'
    | 'ctrl-u'
    | 'printable'
    | 'other';

export function classifyKeyAction(key: string): KeyAction {
    if (key === '\x1b') return 'escape-alone';
    if (key === '\x1b\r' || key === '\x1b\n') return 'option-enter';
    if (key === '\x1b[A' || key === '\x1bOA') return 'arrow-up';
    if (key === '\x1b[B' || key === '\x1bOB') return 'arrow-down';
    if (key === '\x1b[5~') return 'page-up';
    if (key === '\x1b[6~') return 'page-down';
    if (key === '\x1b[H' || key === '\x1b[1~' || key === '\x1bOH') return 'home';
    if (key === '\x1b[F' || key === '\x1b[4~' || key === '\x1bOF') return 'end';
    if (key === '\t') return 'tab';
    if (key === '\r' || key === '\n') return 'enter';
    if (key === '\x7f' || key === '\b') return 'backspace';
    if (key === '\x03') return 'ctrl-c';
    if (key === '\x15') return 'ctrl-u';
    if (key.length > 0 && (key.charCodeAt(0) >= 32 || key.charCodeAt(0) > 127)) return 'printable';
    return 'other';
}
