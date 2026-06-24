// Phase 60: <phase_attestation> evidence blocks are stripped from user-visible text at the
// same broadcast points as the interview tracker. The canonical implementation lives in
// attestation.ts (single source of truth); re-export it here for call-site symmetry.
export { stripPhaseAttestation } from './attestation.js';

/**
 * Strip interview tracker data from user-visible text.
 * Removes both XML-tagged blocks and raw known:/unknown: arrays.
 * Use at every broadcast point — pipeline, lifecycle-handler, etc.
 */
export function stripInterviewTracker(text: string): string {
  let result = text;
  result = result.replace(/<interview_tracker>[\s\S]*?<\/interview_tracker>/g, '');
  result = result.replace(/(?:^|\n)[ \t]*<interview_tracker>[\s\S]*?<\/interview_tracker>/g, '');
  result = result.replace(/(?:^|\n)[ \t]*<interview_tracker>[\s\S]*$/g, '');
  result = stripTrackerField(result, 'assessment', '{', '}');
  result = stripTrackerField(result, 'known', '[', ']');
  result = stripTrackerField(result, 'unknown', '[', ']');
  result = stripDanglingTrackerTail(result);
  result = result.replace(/(?:^|\n)[ \t]*\[Perspective:[^\]\n]*(?:\]|$)[ \t]*(?=\n|$)/g, '');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

function stripTrackerField(text: string, field: string, open: string, close: string): string {
  const re = new RegExp(`\\b${field}:\\s*\\${open}`);
  let out = text;
  let cursor = 0;
  for (;;) {
    const m = re.exec(out.slice(cursor));
    if (!m) break;
    const absStart = cursor + m.index;
    const jsonStart = absStart + m[0].length - 1;
    const endIdx = findBalancedClose(out, jsonStart, open, close);
    if (endIdx < 0) break;
    let lo = absStart;
    while (lo > 0 && (out[lo - 1] === ' ' || out[lo - 1] === '\t')) lo--;
    if (lo > 0 && out[lo - 1] === '\n') lo--;
    out = out.slice(0, lo) + out.slice(endIdx + 1);
    cursor = lo;
  }
  return out;
}

function findBalancedClose(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function stripDanglingTrackerTail(text: string): string {
  const marker = /(?:^|\n)[ \t]*(assessment|known|unknown):\s*(?:\{|\[)/g;
  let out = text;
  let match: RegExpExecArray | null = null;
  while ((match = marker.exec(out)) !== null) {
    const startsAtLineBreak = out[match.index] === '\n';
    const start = startsAtLineBreak ? match.index : match.index;
    const field = match[1];
    const open = field === 'assessment' ? '{' : '[';
    const close = field === 'assessment' ? '}' : ']';
    const jsonStart = out.indexOf(open, match.index);
    if (jsonStart < 0) continue;
    const endIdx = findBalancedClose(out, jsonStart, open, close);
    if (endIdx >= 0) continue;
    out = out.slice(0, start);
    marker.lastIndex = 0;
  }
  return out;
}
