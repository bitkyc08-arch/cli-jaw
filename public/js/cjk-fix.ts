// CJK bold fix — CommonMark 6.2 right-flanking workaround
// Pure function, no browser dependencies — importable from Node.js tests.
//
// Problem: When closing ** is preceded by Unicode punctuation (e.g. ) . ! ?)
// and followed by a non-space non-punctuation char (e.g. CJK), CommonMark
// rejects it as right-flanking → bold fails to render.
//
// Fix: Insert ZWSP between the punctuation and ** so the parser sees **
// as preceded by non-punctuation (ZWSP is Cf, not Zs/P*).

export function fixCjkPunctuationBoundary(text: string): string {
    // 1. Preserve fenced code blocks and inline code spans
    const preserved: string[] = [];
    let processed = text
        .replace(/```[\s\S]*?```/g, (m) => {
            preserved.push(m);
            return `\x00P${preserved.length - 1}\x00`;
        })
        .replace(/`[^`]+`/g, (m) => {
            preserved.push(m);
            return `\x00P${preserved.length - 1}\x00`;
        });

    // 2. Insert ZWSP between punctuation (excluding *) and closing **
    //    when followed by non-space non-punctuation character
    processed = processed.replace(
        /([\p{P}])\*\*(?=[^\s\p{P}])/gu,
        (m, punct) => (punct === '*' ? m : punct + '\u200B**'),
    );

    // 3. Restore preserved spans
    processed = processed.replace(
        /\x00P(\d+)\x00/g,
        (_, i) => preserved[Number(i)],
    );

    return processed;
}
