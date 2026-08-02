// ─── Shared Message Chunking ─────────────────────────
// One splitter for every channel. Promoted from src/slack/format.ts, which is
// the only implementation that survived an adversarial audit; Discord and
// Telegram each grew their own and each lost content in a different way.
//
// The guarantees, in order of importance:
//   1. No content loss. Chunks concatenate back to the input, apart from the
//      ``` markers deliberately injected to keep a split code block closed.
//   2. No split surrogate pairs. Half an emoji is worse than an oversized
//      chunk, and a zero-width cut loops forever.
//   3. Balanced fences. Agent output is code-heavy; a split inside a fence
//      renders the remainder as prose on every channel that speaks markdown.

/** Below this, fence-aware wrapping cannot fit; fall back to a plain split. */
const MIN_FENCE_AWARE_LIMIT = 24;

/**
 * A language tag longer than this is not a real language. Truncating bounds
 * the reserve computation: an unbounded tag could consume the whole budget
 * and leave no room for payload.
 */
const MAX_FENCE_LANG = 20;

/**
 * Bytes a chunk must reserve to reopen an inherited fence and close its own.
 * NOT a constant: reopening as ```typescript costs 14, not the 4 a bare fence
 * costs, and a fixed reserve pushes the chunk past the caller's limit.
 */
export function fenceReserve(lang: string, marker = '```'): number {
    return `${marker}${lang}\n`.length + `\n${marker}`.length;
}

/**
 * A fence left open at the end of a run of text. `marker` is the literal
 * delimiter so a 4-backtick or ~~~ fence reopens and closes with the same run
 * length CommonMark requires.
 */
export interface OpenFence {
    marker: string;
    lang: string;
}

/**
 * Fences are LINE constructs: the delimiter must start a line (up to three
 * spaces of indent), and a closer must be at least as long as its opener and
 * carry no info string.
 *
 * Counting every ``` in the text instead treats a backtick run inside a code
 * block — `const marker = "```";` is ordinary agent output — as a closer, and
 * ships the remainder of the message as prose.
 *
 * SCOPE: top-level fences only. A fence nested in a block quote or list item
 * ("> ```ts", "- ```ts") is not tracked, so such a block splits as prose
 * rather than being reopened. Repairing it would mean carrying the container
 * prefix into every injected marker, which is a larger change than the defect
 * warrants — agent output puts code at the top level.
 */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n`]*)$/;

/** True when the text contains a line-start fence of any delimiter. */
export function hasFence(text: string): boolean {
    return FENCE_ANYWHERE.test(text);
}

const FENCE_ANYWHERE = /^ {0,3}(?:`{3,}|~{3,})/m;

/** The fence still open after `text`, or null when everything is closed. */
export function scanOpenFence(
    text: string,
    initial: OpenFence | null = null,
    /**
     * False when `text` continues a line rather than starting one. A chunker
     * hands us slices, and a delimiter that sits mid-line in the source must
     * not become a fence just because a slice happens to begin there.
     */
    atLineStart = true,
): OpenFence | null {
    let open: OpenFence | null = initial;
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
        if (index === 0 && !atLineStart) continue;
        const m = FENCE_LINE.exec(line);
        if (!m) continue;
        const marker = m[1] ?? '';
        const info = (m[2] ?? '').trim();
        if (open) {
            // A closer uses the same character, is at least as long, and has
            // no info string. Anything else is content inside the block.
            const sameChar = marker[0] === open.marker[0];
            if (sameChar && marker.length >= open.marker.length && info === '') open = null;
            continue;
        }
        open = { marker, lang: fenceLangOf(info) };
    }
    return open;
}

function fenceLangOf(info: string): string {
    return /^[A-Za-z0-9_+#.-]*$/.test(info) ? info.slice(0, MAX_FENCE_LANG) : '';
}

/** Language tag of the fence left open by `text`, or '' when none is open. */
export function trailingFenceLang(text: string): string {
    return scanOpenFence(text)?.lang ?? '';
}

/**
 * Split at a code-point boundary so a cut never separates a surrogate pair.
 * When backing off would produce an empty chunk (a limit so small that a
 * single astral character does not fit), advance instead: emitting one
 * slightly oversized chunk is better than shipping half an emoji, and better
 * than looping forever on a zero-length cut.
 */
export function safeCut(text: string, index: number): number {
    if (index >= text.length) return text.length;
    const code = text.charCodeAt(index);
    const splitsPair = code >= 0xDC00 && code <= 0xDFFF;
    if (!splitsPair) return index;
    return index > 1 ? index - 1 : index + 1;
}

/**
 * Split text into chunks of at most `limit` characters WITHOUT losing content.
 * Prefers newline boundaries; the newline stays with the preceding chunk so
 * chunks concatenate back to the input exactly.
 */
export function splitPreservingContent(text: string, limit: number): string[] {
    const out: string[] = [];
    let rest = text;
    while (rest.length > limit) {
        // Keep the newline in this chunk (+1) rather than dropping it.
        const nl = rest.lastIndexOf('\n', limit - 1);
        let cut = nl > 0 ? nl + 1 : safeCut(rest, limit);
        // A zero cut would never consume input. Take one whole code point.
        if (cut <= 0) cut = safeCut(rest, Math.max(1, Math.min(limit, rest.length)));
        if (cut <= 0) cut = Math.min(2, rest.length);
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest.length > 0) out.push(rest);
    return out;
}

/**
 * Split for a channel that renders ``` code fences.
 *
 * Content is never lost: chunks concatenate back to the input apart from the
 * ``` markers injected to keep each chunk's code block closed.
 */
export function chunkFenceAware(text: string, limit: number): string[] {
    if (!text) return [text];
    const cap = Math.max(1, Math.floor(limit));
    if (text.length <= cap) return [text];

    // No fence in the input means no fence can straddle a boundary, so
    // reserving room for injected markers only wastes budget — and a wasted
    // budget costs the user a whole extra outbound message. The check goes
    // through the lexer so a ~~~ block is not silently sent down the plain
    // path, and an inline ``` run does not force the fence path.
    if (!hasFence(text)) return splitPreservingContent(text, cap);

    // Too small to wrap anything in fences — split plainly rather than spin.
    if (cap < MIN_FENCE_AWARE_LIMIT) return splitPreservingContent(text, cap);

    // Reserve for the worst case this text can produce, so a piece can always
    // carry its reopener and closer. Using the widest tag present keeps the
    // pieces uniform; per-piece reserve would need the split to already exist.
    const worst = widestFenceOpener(text);
    const reserve = fenceReserve(worst.lang, worst.marker);
    // A pathological tag could eat the whole budget. Fall back to bare fences
    // rather than emit zero-payload pieces and never terminate.
    const usableReserve = reserve < cap ? reserve : fenceReserve('');
    const budget = Math.max(1, cap - usableReserve);

    // Every piece is produced from the ORIGINAL text and strictly consumes it,
    // so termination does not depend on how many fences we inject afterwards.
    const rawPieces = splitPreservingContent(text, budget);

    // A piece holding only fence markers and whitespace would post as an empty
    // code block. MERGE it forward into the next piece rather than dropping it
    // — skipping it silently deleted the source's own blank lines.
    // Merging must not push a piece past the budget, or the injected fences
    // would carry it over the caller's limit.
    const pieces: string[] = [];
    let carry = '';
    for (const piece of rawPieces) {
        const candidate = carry + piece;
        if (candidate.length > budget) {
            // Cannot merge without overflowing: emit what we have separately.
            if (carry) pieces.push(carry);
            pieces.push(piece);
            carry = '';
            continue;
        }
        if (candidate.replace(/```/g, '').trim() === '') {
            carry = candidate;
            continue;
        }
        pieces.push(candidate);
        carry = '';
    }
    if (carry) {
        const last = pieces[pieces.length - 1];
        if (last !== undefined && last.length + carry.length <= budget) {
            pieces[pieces.length - 1] = last + carry;
        } else {
            pieces.push(carry);
        }
    }

    const out = closeAndReopen(pieces, reserve < cap, null, usableReserve);
    return out.length > 0 ? out : [text];
}

/**
 * Close a fence a piece leaves open and reopen it on the next piece, so every
 * chunk renders as code on its own. `keepLang` is false only when reserving
 * for the tag would not fit; highlighting is sacrificed before the size limit.
 *
 * Shared with the Telegram rich path so both agree on fence repair, and so a
 * remainder re-split inherits the fence instead of starting as prose.
 */
export function closeAndReopen(
    pieces: string[],
    keepLang = true,
    inheritedStart: OpenFence | null = null,
    /**
     * Largest reopener the caller budgeted for. A split can turn a run that was
     * NOT an opener in the source ("````… x 한한````" carries extra backticks,
     * so it is not a fence) into one, and reopening with that longer delimiter
     * would blow the limit the caller sized for the source's own fences.
     */
    maxReserve = Number.POSITIVE_INFINITY,
): string[] {
    // Pieces were built to fit the payload budget, so the seam fix must respect
    // the same ceiling. Infer it rather than take another parameter: the pieces
    // are the authority on what the splitter considered a full piece.
    const budget = Math.max(...pieces.map((p) => p.length), 1);
    const adjusted = avoidMidLineDelimiterAtSeam(pieces, budget);
    const merged = mergeBareOpenerPieces(adjusted, budget);
    const out: string[] = [];
    let open: OpenFence | null = inheritedStart;
    // A piece starts mid-line whenever the previous one did not end with a
    // newline. Without this, a delimiter that sits inside a line in the source
    // becomes a fence the moment a split lands just before it — inventing a
    // code block and overshooting the caller's limit.
    let atLineStart = true;
    for (const piece of merged) {
        const inherited = open;
        // Scan the ORIGINAL piece: appending the closer below would make the
        // scan report a balanced chunk and drop the carry-over.
        const after = scanOpenFence(piece, inherited, atLineStart);
        let chunk = piece;
        // KNOWN LIMITATION. A delimiter run longer than the budget cannot be
        // reopened without breaking the caller's limit, so its block is not
        // carried across chunks. Usually such a run is an artifact of the split
        // (a backtick sequence that was not an opener in the source), but a
        // genuine `-run wider than the budget is treated the same way.
        //
        // What still holds for those inputs: no content loss, no split
        // surrogate, no chunk over the limit. What does not: the continuation
        // will render as prose rather than code. Delivery beats formatting.
        const repairable = (f: OpenFence | null) =>
            f !== null && fenceReserve(f.lang, f.marker) <= maxReserve;
        if (repairable(inherited)) {
            const tag = keepLang ? inherited!.lang : '';
            chunk = `${inherited!.marker}${tag}\n${chunk}`;
        }
        if (repairable(after)) {
            chunk = chunk.endsWith('\n') ? `${chunk}${after!.marker}` : `${chunk}\n${after!.marker}`;
        }
        out.push(chunk);
        // Carrying an unrepairable fence forward would make every later chunk
        // try (and fail) to reopen it.
        open = repairable(after) ? after : null;
        // A reopener always ends with a newline, so a chunk we reopened still
        // reflects the source's own line state at its end.
        atLineStart = piece.endsWith('\n');
    }
    return out;
}

/**
 * A piece holding nothing but an opening fence line would be emitted as an
 * empty code block, and the next chunk would reopen the same fence — one
 * wasted message carrying no content. Fold it into the piece that follows and
 * push that piece's overflow down the line, exactly as the seam fix does.
 */
function mergeBareOpenerPieces(pieces: string[], budget: number): string[] {
    const out = [...pieces];
    for (let i = 0; i < out.length - 1; i += 1) {
        const piece = out[i] ?? '';
        if (!/^ {0,3}(?:`{3,}|~{3,})[A-Za-z0-9_+#.-]*\n$/.test(piece)) continue;
        out[i + 1] = piece + (out[i + 1] ?? '');
        out.splice(i, 1);
        i -= 1;
        for (let k = Math.max(i + 1, 0); k < out.length; k += 1) {
            const current = out[k] ?? '';
            if (current.length <= budget) break;
            const keep = safeCut(current, budget);
            out[k] = current.slice(0, keep);
            const spill = current.slice(keep);
            if (k + 1 < out.length) out[k + 1] = spill + (out[k + 1] ?? '');
            else out.push(spill);
        }
    }
    return out;
}

/**
 * A reopener ends with a newline, so whatever the next piece starts with lands
 * at column zero. A delimiter run that sat MID-LINE in the source becomes a
 * real fence there, closing the block a message early.
 *
 * Move one code point back across the seam so the run keeps company on its
 * line. Rewriting the payload is not an option: these chunks must still
 * concatenate back to the source.
 */
function avoidMidLineDelimiterAtSeam(pieces: string[], budget: number): string[] {
    const out = [...pieces];
    for (let i = 1; i < out.length; i += 1) {
        const prev = out[i - 1] ?? '';
        const piece = out[i] ?? '';
        if (prev.endsWith('\n')) continue;
        if (!/^ {0,3}(?:`{3,}|~{3,})/.test(piece)) continue;
        // Take a whole code point, and never empty the previous piece — that
        // would stall the walk without fixing anything.
        const low = prev.charCodeAt(prev.length - 1);
        const step = low >= 0xDC00 && low <= 0xDFFF && prev.length >= 2 ? 2 : 1;
        if (prev.length <= step) continue;

        // The receiving piece is usually already full, so growing it would push
        // the chunk past the limit. Push the overflow down the line instead;
        // each piece keeps at most `budget`, and the tail grows a new piece if
        // needed. Content is conserved — nothing is added or dropped, only
        // moved.
        out[i - 1] = prev.slice(0, prev.length - step);
        out[i] = prev.slice(prev.length - step) + piece;
        for (let k = i; k < out.length; k += 1) {
            const current = out[k] ?? '';
            if (current.length <= budget) break;
            const keep = safeCut(current, budget);
            out[k] = current.slice(0, keep);
            const spill = current.slice(keep);
            if (k + 1 < out.length) out[k + 1] = spill + (out[k + 1] ?? '');
            else out.push(spill);
        }
    }
    return out;
}

/**
 * Widest fence opener in the text, for reserve sizing. `initial` lets a caller
 * account for a fence inherited from earlier content: the remainder may close
 * it and open a WIDER one, and missing that overshoots the limit.
 */
export function widestFenceOpener(text: string, initial: OpenFence | null = null): OpenFence {
    let widest: OpenFence = initial ?? { marker: '```', lang: '' };
    let open: OpenFence | null = initial;
    for (const line of text.split('\n')) {
        const m = FENCE_LINE.exec(line);
        if (!m) continue;
        const marker = m[1] ?? '';
        const info = (m[2] ?? '').trim();
        if (open) {
            const sameChar = marker[0] === open.marker[0];
            if (sameChar && marker.length >= open.marker.length && info === '') open = null;
            continue;
        }
        const lang = fenceLangOf(info);
        open = { marker, lang };
        if (fenceReserve(lang, marker) > fenceReserve(widest.lang, widest.marker)) {
            widest = { marker, lang };
        }
    }
    return widest;
}
