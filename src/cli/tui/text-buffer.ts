/**
 * TextBuffer — grapheme-aware single-line/multi-line edit buffer. Pure data structure (no I/O), so the
 * delicate composer/input-handler wiring (Phase 3b) builds on a tested core.
 *
 * Cursor is a GRAPHEME index (so CJK/emoji move as one unit). Supports
 * insert/backspace/delete, left/right + word motions, home/end, an Emacs-style
 * kill-ring (kill-to-end / kill-to-start / kill-word + yank), and undo/redo with
 * insert-run coalescing.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Split a string into grapheme clusters (CJK/emoji safe). Shared with composer.ts. */
export function toGraphemes(s: string): string[] {
    if (!s) return [];
    return Array.from(segmenter.segment(s), (seg) => seg.segment);
}

function isSpace(g: string | undefined): boolean {
    return g !== undefined && /\s/.test(g);
}

interface Snapshot { graphemes: string[]; cursor: number; }
type LastMutation = 'insert' | 'other' | null;

export interface TextBuffer {
    text(): string;
    cursor(): number;
    length(): number;
    insert(s: string): void;
    backspace(): void;
    delete(): void;
    left(): void;
    right(): void;
    wordLeft(): void;
    wordRight(): void;
    home(): void;
    end(): void;
    killToEnd(): void;
    killToStart(): void;
    killWord(): void;
    yank(): void;
    undo(): void;
    redo(): void;
    setText(s: string, cursor?: number): void;
    clear(): void;
}

export function createTextBuffer(initial = ''): TextBuffer {
    let graphemes: string[] = toGraphemes(initial);
    let cursor = graphemes.length;
    let killRing = '';
    const undoStack: Snapshot[] = [];
    const redoStack: Snapshot[] = [];
    let lastMutation: LastMutation = null;

    const clamp = (n: number): number => Math.max(0, Math.min(n, graphemes.length));

    function snapshot(kind: 'insert' | 'other'): void {
        // Coalesce consecutive inserts into a single undo entry.
        if (!(kind === 'insert' && lastMutation === 'insert')) {
            undoStack.push({ graphemes: [...graphemes], cursor });
            redoStack.length = 0;
        }
        lastMutation = kind;
    }

    function spliceIn(parts: string[]): void {
        graphemes.splice(cursor, 0, ...parts);
        cursor += parts.length;
    }

    function wordLeftIndex(): number {
        let i = cursor;
        while (i > 0 && isSpace(graphemes[i - 1])) i--;
        while (i > 0 && !isSpace(graphemes[i - 1])) i--;
        return i;
    }

    return {
        text: () => graphemes.join(''),
        cursor: () => cursor,
        length: () => graphemes.length,

        insert(s: string): void {
            const parts = toGraphemes(s);
            if (!parts.length) return;
            snapshot('insert');
            spliceIn(parts);
        },
        backspace(): void {
            if (cursor <= 0) return;
            snapshot('other');
            graphemes.splice(cursor - 1, 1);
            cursor--;
        },
        delete(): void {
            if (cursor >= graphemes.length) return;
            snapshot('other');
            graphemes.splice(cursor, 1);
        },
        left(): void { cursor = clamp(cursor - 1); },
        right(): void { cursor = clamp(cursor + 1); },
        wordLeft(): void { cursor = wordLeftIndex(); },
        wordRight(): void {
            let i = cursor;
            while (i < graphemes.length && isSpace(graphemes[i])) i++;
            while (i < graphemes.length && !isSpace(graphemes[i])) i++;
            cursor = i;
        },
        home(): void { cursor = 0; },
        end(): void { cursor = graphemes.length; },

        killToEnd(): void {
            if (cursor >= graphemes.length) return;
            snapshot('other');
            killRing = graphemes.splice(cursor).join('');
        },
        killToStart(): void {
            if (cursor <= 0) return;
            snapshot('other');
            killRing = graphemes.splice(0, cursor).join('');
            cursor = 0;
        },
        killWord(): void {
            const start = wordLeftIndex();
            if (start === cursor) return;
            snapshot('other');
            killRing = graphemes.splice(start, cursor - start).join('');
            cursor = start;
        },
        yank(): void {
            if (!killRing) return;
            snapshot('other');
            spliceIn(toGraphemes(killRing));
        },

        undo(): void {
            const prev = undoStack.pop();
            if (!prev) return;
            redoStack.push({ graphemes: [...graphemes], cursor });
            graphemes = prev.graphemes;
            cursor = clamp(prev.cursor);
            lastMutation = null;
        },
        redo(): void {
            const next = redoStack.pop();
            if (!next) return;
            undoStack.push({ graphemes: [...graphemes], cursor });
            graphemes = next.graphemes;
            cursor = clamp(next.cursor);
            lastMutation = null;
        },

        setText(s: string, c?: number): void {
            snapshot('other');
            graphemes = toGraphemes(s);
            cursor = c === undefined ? graphemes.length : clamp(c);
        },
        clear(): void {
            snapshot('other');
            graphemes = [];
            cursor = 0;
        },
    };
}
