export interface IndexedLine { line: number; byteStart: number; byteEndExclusive: number; text: string }
export interface SparseLineChunk { offset: number; endExclusive: number; text: string; firstLine: number; lastLine: number }

const encoder = new TextEncoder();

export function indexInlineLines(text: string): IndexedLine[] {
    const lines: IndexedLine[] = [];
    let charStart = 0;
    let byteStart = 0;
    let line = 1;
    for (let index = 0; index <= text.length; index += 1) {
        if (index !== text.length && text[index] !== '\n') continue;
        const charEnd = index === text.length ? index : index + 1;
        const slice = text.slice(charStart, charEnd);
        const bytes = encoder.encode(slice).byteLength;
        lines.push({ line, byteStart, byteEndExclusive: byteStart + bytes, text: slice });
        byteStart += bytes;
        charStart = charEnd;
        line += 1;
    }
    return lines;
}

export function projectSparseLine(chunks: readonly SparseLineChunk[], line: number): { chunk: SparseLineChunk; offset: number } | null {
    let best: SparseLineChunk | null = null;
    for (const chunk of chunks) {
        if (line >= chunk.firstLine && line <= chunk.lastLine) return { chunk, offset: chunk.offset };
        if (chunk.firstLine <= line && (!best || chunk.firstLine > best.firstLine)) best = chunk;
    }
    return best ? { chunk: best, offset: best.offset } : null;
}

export function lineAtByteOffset(lines: readonly IndexedLine[], byteOffset: number): IndexedLine | null {
    let low = 0;
    let high = lines.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if ((lines[middle]?.byteEndExclusive ?? 0) <= byteOffset) low = middle + 1;
        else high = middle;
    }
    return lines[low] ?? lines.at(-1) ?? null;
}
