import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, type OrcContext } from '../../src/orchestrator/state-machine.ts';
import {
    parsePhaseAttestationObject,
    type PhaseAttestation,
} from '../../src/orchestrator/attestation.ts';

/**
 * Phase 60 — route-level evidence-gate behavior (end-to-end).
 *
 * The route handler in src/routes/orchestrate.ts is an inline closure and cannot be
 * imported directly, so the existing route-contract tests assert against its SOURCE
 * string. That proves the wiring is written, but NOT that the gate actually blocks an
 * agent / lets a human through. This suite reproduces the EXACT decision the route makes
 * — `canTransition(current, target, gateCtx, { actor, attestation, force })` — with the
 * actor + attestation derived the same way the route derives them from the request, and
 * asserts the real outcome for every forward transition and both actors.
 *
 * Route derivation reproduced (orchestrate.ts:805-823):
 *   isAgent      = bossTokenHeader.length > 0 && verifyBossToken(bossTokenHeader)
 *   attestation  = parsePhaseAttestationObject(req.body?.attestation) ?? ctx.pendingAttestation ?? null
 *   gate         = { actor: isAgent ? 'agent' : 'human', attestation, force: isAgent && force }
 */

type Req = {
    bossTokenValid: boolean; // result of verifyBossToken(header) — modeled directly
    body?: { attestation?: unknown; force?: boolean; userInitiated?: boolean };
};

// Mirror of the route's gate-decision block (the part the objective promises).
function routeGateDecision(
    current: 'P' | 'A' | 'B' | 'C',
    target: 'A' | 'B' | 'C' | 'D',
    req: Req,
    ctx: OrcContext | null,
): { status: 200 | 409; reason?: string } {
    const force = req.body?.force === true;
    const userInitiated = req.body?.userInitiated === true;
    const isAgent = req.bossTokenValid;

    const bodyAttestation = parsePhaseAttestationObject(req.body?.attestation);
    const attestation: PhaseAttestation | null =
        bodyAttestation ?? ctx?.pendingAttestation ?? null;

    const humanApproval = !isAgent && (force || userInitiated);
    const gateCtx = humanApproval && ctx ? { ...ctx, userApproved: true } : ctx;

    const gate = canTransition(current, target, gateCtx, {
        actor: isAgent ? 'agent' : 'human',
        attestation,
        force: isAgent && force,
    });
    return gate.ok ? { status: 200 } : { status: 409, reason: gate.reason };
}

const FORWARD: Array<['P' | 'A' | 'B' | 'C', 'A' | 'B' | 'C' | 'D']> = [
    ['P', 'A'],
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'D'],
];

const goodDid = 'wrote the diff-level plan and dispatched the audit worker';
function attFor(from: string, to: string): Record<string, unknown> {
    const base: Record<string, unknown> = { from, to, did: goodDid };
    if (to === 'D') {
        base['checkOutput'] = 'tests 105\npass 105\nfail 0';
        base['exitCode'] = 0;
    }
    return base;
}

test('ORC-E2E-001: AGENT blocked (409) on every forward transition with NO attestation', () => {
    for (const [from, to] of FORWARD) {
        const r = routeGateDecision(from, to, { bossTokenValid: true, body: {} }, baseCtx());
        assert.equal(r.status, 409, `agent ${from}→${to} must be blocked without attestation`);
    }
});

test('ORC-E2E-002: AGENT passes (200) on every forward transition WITH well-formed --attest', () => {
    for (const [from, to] of FORWARD) {
        const r = routeGateDecision(
            from,
            to,
            { bossTokenValid: true, body: { attestation: attFor(from, to) } },
            baseCtx(),
        );
        assert.equal(r.status, 200, `agent ${from}→${to} must pass with a well-formed attestation`);
    }
});

test('ORC-E2E-003: AGENT C→D blocked when checkOutput is missing (narrative did alone is not enough)', () => {
    const r = routeGateDecision(
        'C',
        'D',
        { bossTokenValid: true, body: { attestation: { from: 'C', to: 'D', did: goodDid } } },
        baseCtx(),
    );
    assert.equal(r.status, 409, 'C→D requires a pasted checkOutput');
});

test('ORC-E2E-004: AGENT blocked when attestation from/to does not match the actual transition', () => {
    const r = routeGateDecision(
        'A',
        'B',
        { bossTokenValid: true, body: { attestation: { from: 'P', to: 'A', did: goodDid } } },
        baseCtx(),
    );
    assert.equal(r.status, 409, 'mismatched from/to must not satisfy the gate');
});

test('ORC-E2E-005: AGENT blocked with placeholder/empty/boolean did (no real narrative)', () => {
    // Boolean did is coerced to '' (only string did survives) → rejected. Placeholders rejected.
    for (const bad of ['', '   ', 'tbd', 'todo', 'n/a', 'done', true as unknown as string]) {
        const r = routeGateDecision(
            'A',
            'B',
            { bossTokenValid: true, body: { attestation: { from: 'A', to: 'B', did: bad } } },
            baseCtx(),
        );
        assert.equal(r.status, 409, `did=${JSON.stringify(bad)} must be rejected`);
    }
});

test('ORC-E2E-005b: FORM-ONLY residual — a fabricated but real-looking did string passes (documented)', () => {
    // The gate is form-only: it cannot tell a genuine narrative from a plausible fabrication.
    // This is an accepted residual (laziness-not-malice). Documented in skills_ref/dev-pabcd.
    const r = routeGateDecision(
        'A',
        'B',
        { bossTokenValid: true, body: { attestation: { from: 'A', to: 'B', did: 'did the audit' } } },
        baseCtx(),
    );
    assert.equal(r.status, 200, 'a non-empty, non-placeholder narrative passes the form gate');
});

test('ORC-E2E-006: HUMAN (no boss-token) free pass on A→B and B→C without any attestation', () => {
    // The legacy human path is gated on ctx audit/verification verdicts, satisfied here,
    // and crucially does NOT require an attestation block.
    const okCtx: OrcContext = { ...baseCtx(), auditStatus: 'pass', verificationStatus: 'done' };
    assert.equal(routeGateDecision('A', 'B', { bossTokenValid: false, body: {} }, okCtx).status, 200);
    assert.equal(routeGateDecision('B', 'C', { bossTokenValid: false, body: {} }, okCtx).status, 200);
});

test('ORC-E2E-007: HUMAN userInitiated bypasses the legacy audit/verification gate (free pass)', () => {
    // No attestation, failing ctx verdicts — a human explicit command still passes.
    const failCtx: OrcContext = { ...baseCtx(), auditStatus: 'fail', verificationStatus: 'needs_fix' };
    assert.equal(
        routeGateDecision('A', 'B', { bossTokenValid: false, body: { userInitiated: true } }, failCtx).status,
        200,
        'human free pass: explicit /orchestrate command overrides the legacy gate',
    );
});

test('ORC-E2E-008: AGENT hidden --force overrides the evidence gate (emergency hatch)', () => {
    const r = routeGateDecision('A', 'B', { bossTokenValid: true, body: { force: true } }, baseCtx());
    assert.equal(r.status, 200, 'agent --force is the only override and must pass');
});

test('ORC-E2E-009: invalid boss-token is treated as HUMAN, not agent (free pass, no attestation needed)', () => {
    // bossTokenValid=false models verifyBossToken() rejecting a bad/forged token.
    const okCtx: OrcContext = { ...baseCtx(), auditStatus: 'pass', verificationStatus: 'done' };
    assert.equal(routeGateDecision('A', 'B', { bossTokenValid: false, body: {} }, okCtx).status, 200);
});

function baseCtx(): OrcContext {
    return {
        originalPrompt: 'gate e2e',
        workingDir: null,
        plan: 'p',
        workerResults: [],
        origin: 'test',
    };
}
