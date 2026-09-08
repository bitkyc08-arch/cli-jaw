export class AnsiTerminalModel {
    private lines: string[];
    private row = 0;
    private col = 0;
    private scrollTop = 0;
    private scrollBottom: number;
    /** Lines that left the screen through a top-anchored scroll region (terminal scrollback). */
    readonly scrollback: string[] = [];

    constructor(private columns: number, private rows: number) {
        this.lines = new Array(rows).fill('');
        this.scrollBottom = rows - 1;
    }

    resize(columns: number, rows: number, opts?: { nativePush?: boolean }): void {
        this.columns = columns;
        if (rows < this.rows) {
            // Real terminals (xterm/iTerm2/Terminal.app/kitty) keep the cursor
            // (bottom) visible on a height shrink and push the top rows into
            // scrollback; the default here discards them (legacy tests).
            if (opts?.nativePush) this.scrollback.push(...this.lines.slice(0, this.rows - rows));
            this.lines = this.lines.slice(this.rows - rows);
        } else if (rows > this.rows) {
            const grow = rows - this.rows;
            if (opts?.nativePush) {
                // Realistic grow: mainstream terminals PULL the newest
                // scrollback rows back onto the screen top, in order.
                const pulled = this.scrollback.splice(Math.max(0, this.scrollback.length - grow), grow);
                this.lines = [...new Array(grow - pulled.length).fill(''), ...pulled, ...this.lines];
            } else {
                this.lines = [...new Array(grow).fill(''), ...this.lines];
            }
            this.row += grow;
        }
        this.rows = rows;
        this.row = Math.max(0, Math.min(this.rows - 1, this.row));
        this.col = Math.max(0, Math.min(this.columns - 1, this.col));
        this.scrollTop = 0;
        this.scrollBottom = this.rows - 1;
    }

    write(input: string): void {
        for (let i = 0; i < input.length; i += 1) {
            const ch = input[i] ?? '';
            if (ch === '\x1b' && input[i + 1] === '[') {
                i = this.handleCsi(input, i + 2);
                continue;
            }
            if (ch === '\r') {
                this.col = 0;
                continue;
            }
            if (ch === '\n') {
                this.lineFeed();
                continue;
            }
            this.putChar(ch);
        }
    }

    visibleText(): string {
        return this.lines.join('\n');
    }

    countVisible(pattern: string): number {
        if (!pattern) return 0;
        return this.visibleText().split(pattern).length - 1;
    }

    private handleCsi(input: string, start: number): number {
        let end = start;
        while (end < input.length && !/[A-Za-z]/.test(input[end] ?? '')) end += 1;
        const command = input[end] ?? '';
        const body = input.slice(start, end);
        if (body.startsWith('?')) return end;

        const params = body.split(';').map(part => Number.parseInt(part, 10));
        const n = Number.isFinite(params[0]) ? params[0] : 1;

        if (command === 'A') this.row = Math.max(0, this.row - n);
        else if (command === 'B') this.row = Math.min(this.rows - 1, this.row + n);
        else if (command === 'C') this.col = Math.min(this.columns - 1, this.col + n);
        else if (command === 'H') this.moveTo(params);
        else if (command === 'J') this.eraseDisplay(n);
        else if (command === 'K' && n === 2) this.lines[this.row] = '';
        else if (command === 'r') this.setScrollRegion(params);
        else if (command === 'M') this.deleteLines(n);
        return end;
    }

    private moveTo(params: number[]): void {
        const targetRow = Number.isFinite(params[0]) ? params[0] - 1 : 0;
        const targetCol = Number.isFinite(params[1]) ? params[1] - 1 : 0;
        this.row = Math.max(0, Math.min(this.rows - 1, targetRow));
        this.col = Math.max(0, Math.min(this.columns - 1, targetCol));
    }

    private setScrollRegion(params: number[]): void {
        if (params.length < 2 || !Number.isFinite(params[0]) || !Number.isFinite(params[1])) {
            this.scrollTop = 0;
            this.scrollBottom = this.rows - 1;
            return;
        }
        const top = Math.max(0, Math.min(this.rows - 1, params[0] - 1));
        const bottom = Math.max(0, Math.min(this.rows - 1, params[1] - 1));
        // DECSTBM requires bottom > top: real terminals silently IGNORE a
        // 1-row (or inverted) region. @xterm/headless also treats CSI 1;1r as a no-op;
        // the \r\n just moves the cursor and nothing enters scrollback).
        // Accepting it here masked exactly that product bug.
        if (bottom <= top) return;
        this.scrollTop = top;
        this.scrollBottom = bottom;
    }

    /** DL — delete n lines at the cursor row within the scroll region. Rows
     *  below shift up, blanks open at the region bottom; NOTHING enters
     *  scrollback (unlike a region-top-1 scroll). */
    private deleteLines(n: number): void {
        if (this.row < this.scrollTop || this.row > this.scrollBottom) return;
        for (let k = 0; k < n; k += 1) {
            for (let r = this.row; r < this.scrollBottom; r += 1) {
                this.lines[r] = this.lines[r + 1] ?? '';
            }
            this.lines[this.scrollBottom] = '';
        }
    }

    private eraseDisplay(mode: number): void {
        if (mode === 2 || mode === 3) {
            this.lines = new Array(this.rows).fill('');
            // 3J erases the SAVED lines (terminal scrollback); 2J only the
            // visible screen. Modeling both as visible-only made scrollback
            // wipes (launch clear, discard-scrollback resize) invisible to
            // assertions.
            if (mode === 3) this.scrollback.length = 0;
            return;
        }
        if (mode === 0) {
            const current = this.lines[this.row] ?? '';
            this.lines[this.row] = current.slice(0, this.col);
            for (let r = this.row + 1; r < this.rows; r += 1) this.lines[r] = '';
        }
    }

    private putChar(ch: string): void {
        const current = this.lines[this.row] ?? '';
        const padded = current.padEnd(this.col, ' ');
        this.lines[this.row] = (padded.slice(0, this.col) + ch + padded.slice(this.col + 1)).slice(0, this.columns);
        this.col = Math.min(this.columns - 1, this.col + 1);
    }

    private lineFeed(): void {
        if (this.row === this.scrollBottom) {
            // Region top at row 1 → the departing line enters scrollback
            // (Ghostty PR #9907 semantics); top > 1 silently discards it.
            if (this.scrollTop === 0) this.scrollback.push(this.lines[0] ?? '');
            for (let r = this.scrollTop; r < this.scrollBottom; r += 1) {
                this.lines[r] = this.lines[r + 1] ?? '';
            }
            this.lines[this.scrollBottom] = '';
            return;
        }
        this.row = Math.min(this.rows - 1, this.row + 1);
    }
}
