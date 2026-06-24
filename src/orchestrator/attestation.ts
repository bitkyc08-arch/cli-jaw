// ─── PABCD Phase Attestation ────────────────────────
// Form-only evidence gate for PABCD phase transitions. The agent must submit a
// well-formed <phase_attestation> block (via the `--attest` CLI arg, or emitted in
// its message) with a non-empty narrative `did` field to advance. C→D additionally
// requires a pasted command output (checkOutput). The gate does NOT verify the
// narrative against ctx — the adversary is the agent's own laziness/hallucination,
// not a malicious human, so a forcing function (commit to a specific narrative +
// paste real output for C→D) is the goal, not cryptographic unfakeability.
//
// Design notes (devlog/_plan/260624_pabcd_evidence_gate/):
//  - Booleans are NOT accepted as evidence (a boolean is cheaper to hallucinate than
//    prose and launders a lie into a green checkmark) → require a narrative `did`.
//  - No ctx.auditStatus/verificationStatus enforcement (those are only set by the
//    server dispatch path; a legit CLI-sub-agent audit would false-negative-block).
//  - type-only OrcStateName import → no runtime import cycle with state-machine.

import type { OrcStateName } from './state-machine.js';

export type Phase = 'P' | 'A' | 'B' | 'C' | 'D';

export interface PhaseAttestation {
  from: Phase;
  to: Phase;
  /** Required narrative of what the agent actually did this phase (NOT a boolean). */
  did: string;
  /** C→D only: pasted tail of the actual tsc/test command output. */
  checkOutput?: string;
  /** Optional exit code; if present and non-zero, C→D is rejected. */
  exitCode?: number;
  /** The raw source the attestation was parsed from (block text or JSON string). */
  raw: string;
}

const PHASES: ReadonlySet<string> = new Set(['P', 'A', 'B', 'C', 'D']);

// Forward dev transitions that require an attestation. I/IDLE/reject paths are exempt.
const GATED_TRANSITIONS: ReadonlySet<string> = new Set(['P>A', 'A>B', 'B>C', 'C>D']);

// Obvious placeholders that do not count as a real narrative.
const PLACEHOLDER_DID = /^(tbd|todo|n\/?a|none|done|ok|\.+|-+)$/i;

function isPhase(v: unknown): v is Phase {
  return typeof v === 'string' && PHASES.has(v);
}

function coerce(obj: Record<string, unknown>, raw: string): PhaseAttestation | null {
  const from = obj['from'];
  const to = obj['to'];
  if (!isPhase(from) || !isPhase(to)) return null;
  const did = typeof obj['did'] === 'string' ? obj['did'].trim() : '';
  const att: PhaseAttestation = { from, to, did, raw };
  if (typeof obj['checkOutput'] === 'string') att.checkOutput = obj['checkOutput'].trim();
  if (typeof obj['exitCode'] === 'number' && Number.isFinite(obj['exitCode'])) {
    att.exitCode = obj['exitCode'] as number;
  }
  return att;
}

/**
 * Parse the <phase_attestation>{…JSON…}</phase_attestation> tagged block from agent text.
 * Returns null when no well-formed block with valid from/to is present. A block missing
 * `did` still parses (did:'') so the gate can return a clear "did is required" reason.
 */
export function parsePhaseAttestation(text: string): PhaseAttestation | null {
  if (!text || typeof text !== 'string') return null;
  const block = text.match(/<phase_attestation>\s*([\s\S]*?)\s*<\/phase_attestation>/i);
  if (!block || !block[1]) return null;
  const body = block[1].trim();
  try {
    const obj = JSON.parse(body);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return coerce(obj as Record<string, unknown>, body);
  } catch {
    return null;
  }
}

/**
 * Validate/coerce an already-parsed JSON object (from the CLI `--attest` request body)
 * into a PhaseAttestation. This is the gate's source of truth (no parse-timing dependency).
 */
export function parsePhaseAttestationObject(obj: unknown): PhaseAttestation | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const raw = (() => { try { return JSON.stringify(obj); } catch { return ''; } })();
  return coerce(obj as Record<string, unknown>, raw);
}

/**
 * Strip the <phase_attestation> block from user-visible text (mirror stripInterviewTracker).
 * Handles a trailing block with or without a closing tag.
 */
export function stripPhaseAttestation(text: string): string {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  out = out.replace(/<phase_attestation>[\s\S]*?<\/phase_attestation>/gi, '');
  // Dangling open tag with no close (truncated output).
  out = out.replace(/(?:^|\n)[ \t]*<phase_attestation>[\s\S]*$/i, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

export interface GateResult {
  ok: boolean;
  reason?: string;
}

/**
 * FORM-ONLY transition gate. Only the 4 forward dev transitions (P→A, A→B, B→C, C→D)
 * require an attestation; everything else returns ok. Does NOT read OrcContext.
 */
export function checkAttestationGate(
  from: OrcStateName,
  to: OrcStateName,
  att: PhaseAttestation | null,
): GateResult {
  const key = `${from}>${to}`;
  if (!GATED_TRANSITIONS.has(key)) return { ok: true };

  if (!att) {
    return {
      ok: false,
      reason: `${from} → ${to} requires a <phase_attestation> block with a non-empty "did" describing the real work you did this phase. Pass it via --attest '{"from":"${from}","to":"${to}","did":"..."}'.`,
    };
  }
  if (att.from !== from || att.to !== to) {
    return {
      ok: false,
      reason: `Attestation from/to (${att.from}→${att.to}) does not match the requested transition ${from}→${to}.`,
    };
  }
  if (!att.did || PLACEHOLDER_DID.test(att.did)) {
    return {
      ok: false,
      reason: `${from} → ${to} attestation needs a specific "did" narrative (not empty or a placeholder) describing what you actually did.`,
    };
  }
  if (key === 'C>D') {
    if (!att.checkOutput) {
      return {
        ok: false,
        reason: `C → D additionally requires "checkOutput": paste the tail of the tsc/test command you actually ran.`,
      };
    }
    if (typeof att.exitCode === 'number' && att.exitCode !== 0) {
      return {
        ok: false,
        reason: `C → D requires a passing check, but the attestation reports exitCode ${att.exitCode}. Fix the failure (orchestrate B) before advancing.`,
      };
    }
  }
  return { ok: true };
}

// ─── No-state narration detector ─────────────────────
// Cheap heuristic: detect when the agent ASSERTS a current PABCD phase in prose while the
// orchestrator state is IDLE (i.e. it never actually entered the state machine). Used by the
// pipeline to emit a one-time correction. Detect+warn only — never blocks. Tuned narrow to
// avoid false positives when merely EXPLAINING what PABCD is.
const NO_STATE_PATTERNS: RegExp[] = [
  // "현재는 P입니다", "현재 A 단계", "지금 B 단계입니다"
  /(현재|지금)\s*(는|은)?\s*\(?[PABCD]\)?\s*(단계|페이즈|phase|상태|입니다|이에요|예요)/i,
  // "P 단계로 (진입|진행|들어)" / "A phase로 진행"
  /\b[PABCD]\s*(단계|페이즈|phase)\s*(로|에서|로서)?\s*(진입|진행|들어|시작)/i,
  // "now in phase B" / "entering the A phase" / "currently in phase C"
  /\b(now|currently|entering)\s+(in\s+)?(the\s+)?(phase\s+[PABCD]|[PABCD]\s+phase)\b/i,
];

/**
 * Returns true if the text asserts a current PABCD phase (heuristic narration) — used to
 * detect "현재는 P입니다" style hallucination when the real state is IDLE. The caller is
 * responsible for confirming state===IDLE and that no real `cli-jaw orchestrate` command ran.
 */
export function detectNoStateNarration(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  // Ignore fenced code blocks (docs explaining PABCD often live there).
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  return NO_STATE_PATTERNS.some(re => re.test(stripped));
}
