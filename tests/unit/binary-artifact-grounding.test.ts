import test from 'node:test';
import assert from 'node:assert/strict';

import { checkBinaryArtifactGrounding, checkAttestationGate } from '../../src/orchestrator/attestation.ts';
import type { PhaseAttestation } from '../../src/orchestrator/attestation.ts';

// #522: the bot rendered PDFs and posted them without ever looking at what it
// produced. A document with missing CJK fonts renders every Korean glyph as a
// tofu box, passes every static gate, and reaches the user broken — twice
// observed live, both times found by the user rather than by us.
//
// The refusal surface is the risk. This sits on the main forward path of every
// PABCD cycle, so the tests that matter most are the ones proving it does NOT
// fire on work that merely names a document.

function att(did: string, checkOutput = 'tsc clean'): PhaseAttestation {
    return { from: 'C', to: 'D', did, checkOutput, exitCode: 0 } as PhaseAttestation;
}

test('ATT-BIN-001: a produced document with no observation is refused', () => {
    const reason = checkBinaryArtifactGrounding(att('rendered the quarterly report to report.pdf and posted it'));
    assert.ok(reason, 'this is the case the issue reported twice');
    assert.match(reason, /opened|open/i, 'the refusal must say what to do about it');
});

test('ATT-BIN-002: observing the output lets the phase advance', () => {
    assert.equal(checkBinaryArtifactGrounding(att('rendered report.pdf, opened page 1 with pdftoppm, Korean text renders')), null);
    assert.equal(checkBinaryArtifactGrounding(att('built deck.pptx and took a screenshot of every slide')), null);
});

test('ATT-BIN-003: a Korean observation counts, because these attestations are Korean', () => {
    // An English-only vocabulary would refuse an agent that DID open the file.
    assert.equal(checkBinaryArtifactGrounding(att('보고서.pdf 를 렌더하고 직접 열어서 한글 깨짐 없는지 확인함')), null);
});

test('ATT-BIN-004: the escape hatch survives', () => {
    assert.equal(checkBinaryArtifactGrounding(att('fixed the export bug for report.pdf (render-not-applicable)')), null);
});

test('ATT-BIN-005: a SOURCE file with a format segment is not a document', () => {
    // The one that matters most. `.` is a word boundary, so a naive pattern
    // refuses `export.pdf.ts` — a pure code change — and demands a screenshot of
    // a document that was never produced.
    assert.equal(checkBinaryArtifactGrounding(att('fixed the crash in export.pdf.ts writer')), null);
    assert.equal(checkBinaryArtifactGrounding(att('updated report.docx.snap after the schema change')), null);
    assert.equal(checkBinaryArtifactGrounding(att('refactored pdf-export.ts into two modules')), null);
});

test('ATT-BIN-006: naming a document you did not produce is not a claim', () => {
    // A filename is also how you refer to a file you changed, replaced or
    // deleted. An agent that learns the gate fires on work it did not do learns
    // to reach for the override instead.
    for (const did of [
        'replaced the stale tests/fixtures/invoice.docx test input',
        'regenerated the golden fixtures/sample.pdf and updated the parser',
        'deleted the obsolete report.pdf and dropped its route',
        'documented how to export report.pdf in the README',
    ]) {
        assert.equal(checkBinaryArtifactGrounding(att(did)), null, did);
    }
});

test('ATT-BIN-007: ordinary code work never reaches this gate', () => {
    assert.equal(checkBinaryArtifactGrounding(att('refactored database query in user-service.ts')), null);
    assert.equal(checkBinaryArtifactGrounding(att('added rate limiting to the auth middleware')), null);
});

test('ATT-BIN-008: the block runs BEFORE the advisory, or it is unreachable', () => {
    // The widened RENDER_ARTIFACT_PATTERN now matches a produced document too,
    // so an advisory-first order would return ok:true and this would be dead code.
    const result = checkAttestationGate('C', 'D', att('exported the summary to report.pdf'));
    assert.equal(result.ok, false, 'the produced document must refuse, not merely warn');
});

test('ATT-BIN-009: html without observation stays an ADVISORY, not a refusal', () => {
    // The reason this is a separate predicate: three existing tests assert the
    // html case advances with a warning. Reusing the advisory for blocking
    // would have turned them red.
    const result = checkAttestationGate('C', 'D', att('built dashboard.html with the new chart'));
    assert.equal(result.ok, true, 'a render artifact warns; a binary document refuses');
    assert.ok(result.advisory, 'and the warning still fires');
});
