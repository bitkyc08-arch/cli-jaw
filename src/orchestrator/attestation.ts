// ─── PABCD Phase Attestation ────────────────────────
// Form-only evidence gate for PABCD phase transitions. The agent must submit a
// well-formed <phase_attestation> block (via the `--attest` CLI arg, or emitted in
// its message) with a non-empty narrative `did` field to advance. C→D additionally
// requires a pasted command output (checkOutput). The gate does NOT verify the
// narrative against ctx — the adversary is the agent's own laziness/hallucination,
// not a malicious human, so a forcing function (commit to a specific narrative +
// paste real output for C→D) is the goal, not cryptographic unfakeability.
//
// Design notes:
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
  /**
   * P→A: the plan unit this cycle is working out of, at the location designated by project policy.
   * Advisory-only — a missing unit does not block, but it is no longer discarded.
   */
  planUnit?: string;
  /** Optional work-phase id, for multi-cycle work under one objective. */
  workPhaseId?: string;
  /** A→B: pasted tail of the reviewer's verdict. */
  auditOutput?: string;
  /**
   * A→B: the MAIN agent's judgement of the audit round (AUDIT-LOOP-01). A declared
   * `fail` BLOCKS the transition; the other values pass. Unrecognized strings are
   * dropped rather than guessed at, so a typo cannot smuggle a fail past the gate as
   * an unknown value — it is simply absent, and absence is advisory.
   */
  auditVerdict?: 'pass' | 'near-pass' | 'fail';
  /** A→B, near-pass only: each residual blocker and its disposition. */
  auditResidual?: string;
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
  // Audit and plan-unit fields. These used to be dropped here with no error and no
  // warning, which meant a caller could write `auditVerdict: "fail"` and watch the
  // transition succeed — the field vanished before any gate saw it. Parsing them does
  // not by itself make them required; see checkAttestationGate for what each one does.
  for (const key of ['planUnit', 'workPhaseId', 'auditOutput', 'auditResidual'] as const) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) att[key] = v.trim();
  }
  const verdict = obj['auditVerdict'];
  if (verdict === 'pass' || verdict === 'near-pass' || verdict === 'fail') {
    att.auditVerdict = verdict;
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
  /** Soft-warning advisory text. Present only when ok===true and something looks off. */
  advisory?: string;
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
  if (key === 'A>B') {
    // AUDIT-LOOP-01: a FAIL round never exits A. This is the one audit rule a form-only
    // gate can actually enforce — it needs no cross-check against runtime state, only
    // the agent's own recorded judgement. Blocking here cannot break an existing caller
    // because nothing sent this field until now; the field's absence stays advisory.
    if (att.auditVerdict === 'fail') {
      return {
        ok: false,
        reason:
          `A → B is refused: the attestation declares auditVerdict "fail". A failed audit round ` +
          `never exits A (AUDIT-LOOP-01). Record the synthesis (per-blocker root cause, conflicts, ` +
          `accept/rebut per point), amend the plan, and re-audit with the SAME reviewer. After 3 ` +
          `failed rounds, return to P with a changed plan instead.`,
      };
    }
    if (att.auditVerdict === 'near-pass' && !att.auditResidual) {
      return {
        ok: false,
        reason:
          `A → B declares auditVerdict "near-pass" but carries no "auditResidual". Near-pass means ` +
          `every High/Critical blocker was folded in as a concrete amendment or explicitly rebutted ` +
          `with recorded rationale — name each residual and its disposition, or declare "pass".`,
      };
    }
    const advisory = checkAuditEvidenceAdvisory(att);
    if (advisory) return { ok: true, advisory };
  }
  if (key === 'P>A' && !att.planUnit) {
    return {
      ok: true,
      advisory:
        `[UNIT-RESIDENCE-01 advisory] P → A carries no "planUnit". The diff-level plan should ` +
        `live at the explicit worklog or project-approved planning location, including an external repository when required by project policy, rather than only in this narrative. ` +
        `Pass it as "planUnit" so a later reader can find the plan this cycle was built from.`,
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
    // A produced BINARY document is the one artifact class where "it compiled" says
    // nothing: a PDF with tofu boxes for every Korean glyph passes every static gate
    // and is unreadable (#522). That is a refusal, not a warning.
    //
    // BEFORE the advisory, and the order is load-bearing: the widened
    // RENDER_ARTIFACT_PATTERN now matches a produced document too, so an
    // advisory-first arrangement would return ok:true here and leave this
    // block unreachable.
    const binaryBlock = checkBinaryArtifactGrounding(att);
    if (binaryBlock) {
      return { ok: false, reason: binaryBlock };
    }
    // Render-grounding soft warning (C-RENDER-GROUNDING-01): when the did/checkOutput
    // mentions render-artifact file types but lacks observation vocabulary, emit an
    // advisory. The gate remains a pass — this is a warning, never a block.
    const advisory = checkRenderGroundingAdvisory(att);
    if (advisory) {
      return { ok: true, advisory };
    }
  }
  return { ok: true };
}

// ─── Audit-evidence soft warning (AUDIT-LOOP-01) ────────────────
// A→B is where a plan audit is supposed to have happened. The gate cannot verify that a
// reviewer really ran — that is the faithful-execution obligation the form-only gate
// explicitly does not cover — but it CAN notice that the attestation offers no evidence
// either way, and say so instead of passing in silence.

/**
 * Returns advisory text when an A→B attestation records no audit evidence at all: no
 * verdict, and no pasted reviewer output. Returns null once either is present, since a
 * `pass` with output is a complete claim and a bare `pass` is at least an explicit one.
 */
export function checkAuditEvidenceAdvisory(att: PhaseAttestation): string | null {
  if (att.auditVerdict || att.auditOutput) return null;
  return (
    '[AUDIT-LOOP-01 advisory] A → B carries no "auditVerdict" and no "auditOutput". ' +
    'A is a loop — audit, synthesize, amend, re-audit — and it exits only on a ' +
    'main-agent-judged pass or near-pass. Record the judgement as "auditVerdict" ' +
    '("pass" | "near-pass" | "fail") and paste the reviewer\'s verdict tail as ' +
    '"auditOutput", so the round is re-readable later. A declared "fail" is refused.'
  );
}

// ─── Render-grounding soft warning (C-RENDER-GROUNDING-01) ──────
// When a C→D attestation's did/checkOutput text mentions render-artifact file types
// (html, svg, css, canvas, chart, jsx, tsx, animation) but lacks render-observation
// vocabulary (screenshot, render, observed, headless, viewport, render-not-applicable),
// emit an advisory warning. The gate result always remains ok:true.

/** File-type keywords that indicate a render artifact was likely involved. */
const RENDER_ARTIFACT_PATTERN = /(?:\b|\.)(html|svg|css|jsx|tsx|canvas|chart|animation|pdf|docx|pptx|xlsx|hwpx?|png|jpe?g)\b|\b(ui|game)\b/i;

/** Observation vocabulary that indicates the agent actually ran and observed the artifact. */
const RENDER_OBSERVATION_PATTERN = /\b(screenshot|render|rendered|observed|headless|viewport|render-not-applicable|visual|browser|puppeteer|playwright|pdftoppm|opened|displayed|inspected)\b/i;

/**
 * Returns advisory text when a C→D attestation mentions render-artifact file types
 * without corresponding render-observation vocabulary. Returns null when no warning
 * is warranted (either no render artifacts mentioned, or observation is present).
 */
export function checkRenderGroundingAdvisory(att: PhaseAttestation): string | null {
  const combined = `${att.did} ${att.checkOutput || ''}`;
  if (!RENDER_ARTIFACT_PATTERN.test(combined)) return null;
  if (RENDER_OBSERVATION_PATTERN.test(combined)) return null;
  return (
    '[C-RENDER-GROUNDING-01 advisory] The attestation mentions render-artifact types ' +
    '(html/svg/css/canvas/chart/jsx/tsx) but does not reference a render observation ' +
    '(screenshot/render/observed/headless/viewport). If this work-phase produced a ' +
    'visual artifact, consider running and observing it before advancing. ' +
    'If render grounding does not apply, mention "render-not-applicable" in the did.'
  );
}

/** A document format whose correctness only exists when someone opens it.
 *
 *  The extension must be TERMINAL. Matching `.pdf` anywhere would refuse
 *  `export.pdf.ts` — a source file — because `.` is a word boundary, turning a
 *  pure code change into a demand to screenshot a document it never produced. */
const BINARY_DOCUMENT_PATTERN = /\.(pdf|docx|pptx|xlsx|hwpx?|png|jpe?g)(?![\p{L}\p{N}._-])/iu;

/** Evidence that someone actually LOOKED AT the document.
*
 *  `render`/`rendered`/`렌더` are deliberately ABSENT. Rendering is how the
 *  document was PRODUCED, not evidence that anyone saw the result — and
 *  "rendered the report to report.pdf" is the exact sentence this gate exists
 *  to question.
 *
*  Korean terms are included deliberately: attestations in this repo are
*  routinely written in Korean, and an English-only vocabulary would refuse an
*  agent that DID open the file and said so. */
const BINARY_OBSERVATION_PATTERN = /\b(screenshot|observed|headless|pdftoppm|opened|displayed|inspected|viewed|render-not-applicable|preview|thumbnail)\b|열어|열었|확인했|확인함|검토했|스크린샷|미리보기/i;

/** Work that NAMES a document without producing one.
 *
 *  A filename is also how you refer to a file you changed, replaced or deleted.
 *  Without this, `replaced the stale fixtures/invoice.docx test input` is
 *  refused — and an agent that learns the gate fires on work it did not do
 *  learns to reach for the override, which is worse than no gate. */
const BINARY_NON_PRODUCTION_PATTERN = /\b(fixture|fixtures|golden|snapshot|test input|deleted|removed|obsolete|stale|documented|documentation|readme|parser|writer|import|imports|imported|parse|parsing)\b|삭제|제거|픽스처|문서화/i;

/**
 * Refuse a C→D that claims a produced binary document with no sign anyone looked
 * at it. Returns the refusal reason, or null when the phase may advance.
 *
 * Separate from the advisory on purpose: `html` without observation must stay a
 * warning (three existing tests assert exactly that), while a produced PDF is
 * the case where passing static gates proves nothing at all.
 */
export function checkBinaryArtifactGrounding(att: PhaseAttestation): string | null {
  // `did` only. A fixture path in pasted command output is not a claim to have
  // produced a document.
  const did = att.did || '';
  if (!BINARY_DOCUMENT_PATTERN.test(did)) return null;
  if (BINARY_OBSERVATION_PATTERN.test(did)) return null;
  if (BINARY_OBSERVATION_PATTERN.test(att.checkOutput || '')) return null;
  if (BINARY_NON_PRODUCTION_PATTERN.test(did)) return null;
  return (
    '[C-RENDER-GROUNDING-01] This attestation says it produced a binary document, ' +
    'but nothing in it says anyone opened the result. A document can satisfy every ' +
    'static gate and still be unreadable — missing CJK fonts render every Korean ' +
    'glyph as a tofu box, and no test catches that. Open the output (pdftoppm, a ' +
    'screenshot, a viewer), say what you saw, and attest again. ' +
    'If you did not produce this document, say "render-not-applicable" in the did.'
  );
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
