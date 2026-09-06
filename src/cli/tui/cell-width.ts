/** Shared modern-terminal cell policy. Measure NFC, preserve original display text. */
const zeroCell = /[\p{Mark}\p{Default_Ignorable_Code_Point}]/u;
const emojiPresentation = /\p{Emoji_Presentation}/u;
const emoji = /\p{Emoji}/u;
const pictograph = /\p{Extended_Pictographic}/u;

function baseCells(cp: number): number {
    if (cp < 32 || (cp >= 0x7f && cp <= 0x9f)) return 0;
    if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e)
        || (cp >= 0x3040 && cp <= 0x33bf) || (cp >= 0x3400 && cp <= 0x4dbf)
        || (cp >= 0x4e00 && cp <= 0xa4cf) || (cp >= 0xa960 && cp <= 0xa97c)
        || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff)
        || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff01 && cp <= 0xff60)
        || (cp >= 0xffe0 && cp <= 0xffe6) || cp === 0x23f3 || cp === 0x231b
        || (cp >= 0x1f000 && cp <= 0x1ffff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
    return 1;
}

export function graphemeCellWidth(grapheme: string): number {
    const value = grapheme.normalize('NFC');
    const textPresentation = value.includes('\ufe0e');
    if ((!textPresentation && emojiPresentation.test(value))
        || (value.includes('\ufe0f') && emoji.test(value))
        || /[0-9#*]\ufe0f?\u20e3/u.test(value)
        || (value.includes('\u200d') && pictograph.test(value))) return 2;
    let width = 0;
    for (const char of value) {
        const cp = char.codePointAt(0)!;
        if (zeroCell.test(char) || (cp >= 0x1160 && cp <= 0x11ff) || (cp >= 0xd7b0 && cp <= 0xd7ff)) continue;
        width += baseCells(cp);
    }
    return width;
}

export function fitCellGrapheme(grapheme: string, columns: number): { text: string; width: number } {
    const width = graphemeCellWidth(grapheme);
    const limit = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
    return width > limit ? { text: '?', width: 1 } : { text: grapheme, width };
}
