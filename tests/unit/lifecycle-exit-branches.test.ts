import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    classifyExitError,
    shouldAnnounceStallTruncation,
    STALL_TRUNCATION_NOTICE,
} from '../../src/agent/error-classifier.ts';

// The exit handler's else-if chain decides which explanation a reader gets:
//
//   output present                      → output branch   ← the gap (#405)
//   code!==0 && wasKilled && stallReason → stall branch    ← unreachable for the watchdog
//   code!==0 && !wasKilled               → error branch    ← where a silent stall goes
//
// A watchdog kill that produced partial output stops at the first branch, which
// said nothing about being cut short. The turn just ended mid-thought.

test('LEB-001: a watchdog kill with output is announced — without wasKilled', () => {
    // wasKilled is deliberately absent from the input. The watchdog never writes
    // killReasons, so requiring it would make this branch unreachable — which is
    // the failure mode this exists to prevent.
    assert.equal(shouldAnnounceStallTruncation({
        stallReason: 'absolute timeout 933s; lastProgress=output x302',
        wasSteer: false, mainManaged: true, internal: false,
    }), true);
});

test('LEB-002: a user stop is not a timeout', () => {
    assert.equal(shouldAnnounceStallTruncation({
        stallReason: 'absolute timeout 933s', wasSteer: true, mainManaged: true, internal: false,
    }), false);
});

test('LEB-003: a turn that simply finished says nothing', () => {
    for (const stallReason of [undefined, null, '']) {
        assert.equal(shouldAnnounceStallTruncation({
            stallReason, wasSteer: false, mainManaged: true, internal: false,
        }), false, `no stall reason means no notice: ${JSON.stringify(stallReason)}`);
    }
});

test('LEB-004: runs with no reader stay quiet', () => {
    const stallReason = 'absolute timeout 933s';
    assert.equal(shouldAnnounceStallTruncation({
        stallReason, wasSteer: false, mainManaged: false, internal: false,
    }), false, 'a sub-agent run has no channel to explain itself to');
    assert.equal(shouldAnnounceStallTruncation({
        stallReason, wasSteer: false, mainManaged: true, internal: true,
    }), false, 'an internal run has no reader either');
});

test('LEB-005: a silent stall is still explained, by the other branch', () => {
    // No output means the error branch, which passes stallReason into
    // classifyExitError. So the user is told either way, and the two messages
    // are different — the output branch cannot double up on this one.
    const classified = classifyExitError(
        'cursor', 1, '', 'absolute timeout 933s; lastProgress=output x302',
    );
    assert.equal(classified.isStall, true);
    assert.match(classified.message, /응답 없음/);
    assert.notEqual(classified.message, STALL_TRUNCATION_NOTICE);
});

test('LEB-007: cursor lowercase resource_exhausted classifies as 429 (suji live evidence)', () => {
    // cursor-agent prints "RetriableError: [resource_exhausted]" — lowercase.
    // The old cased includes('RESOURCE_EXHAUSTED') missed it, so those turns
    // died with exit 1 and no retry (observed on suji, 2026-08-24).
    const c = classifyExitError('cursor', 1, 'RetriableError: [resource_exhausted] Error', undefined);
    assert.equal(c.is429, true);
    assert.equal(c.isConnection, false, '429 is not a connection error');
});

test('LEB-008: cursor ConnectRPC loss classifies as connection and joins the retry path', () => {
    const c = classifyExitError(
        'cursor', 1,
        'Connection lost. Failed to reconnect to api2.cursor.sh after 3 attempts.',
        undefined,
    );
    assert.equal(c.isConnection, true);
    assert.equal(c.is429, false);
    assert.match(c.message, /연결 오류/);
    // ECONNRESET-style OS errors count too.
    assert.equal(classifyExitError('cursor', 1, 'read ECONNRESET', undefined).isConnection, true);
});

test('LEB-009: a locked keychain is auth, never a connection retry', () => {
    const c = classifyExitError(
        'cursor', 1,
        'Your macOS login keychain is locked. Set AGENT_CLI_CREDENTIAL_STORE=file.',
        undefined,
    );
    assert.equal(c.isAuth, true);
    assert.equal(c.isConnection, false, 'respawning cannot unlock a keychain');
    assert.match(c.message, /인증 오류/);
});

test('LEB-010: ordinary prose containing the word unavailable is not a connection error', () => {
    const c = classifyExitError('cursor', 1, 'The requested feature is unavailable in this plan.', undefined);
    assert.equal(c.isConnection, false, 'bare English "unavailable" must not trigger transport retry');
});

test('LEB-006: the output branch uses the shared decision, not its own condition', () => {
    // Guards the wiring the pure tests above cannot see: a copy of the condition
    // inlined here would drift from what LEB-001..004 verify.
    const src = readFileSync(
        join(import.meta.dirname, '..', '..', 'src/agent/lifecycle-handler.ts'), 'utf8',
    );
    const outputBranch = src.slice(
        src.indexOf('// ─── Output handling ───'),
        src.indexOf('const { message: errMsg } = classifyExitError('),
    );
    assert.match(outputBranch, /shouldAnnounceStallTruncation\(\{/);
    assert.match(outputBranch, /STALL_TRUNCATION_NOTICE/);
});

// The notice has to reach the READER, and the channels do not read the
// agent_done payload — they answer from the text this handler resolves. A
// notice that reached only the broadcast showed up in the web transcript while
// the Slack reply still trailed off mid-thought: the exact symptom, still there,
// with everything above this line green (#405).
//
// Where it must NOT go is LEB-010's subject.
test('LEB-007: the notice lands on the resolved text', () => {
    const src = readFileSync(
        join(import.meta.dirname, '..', '..', 'src/agent/lifecycle-handler.ts'), 'utf8',
    );
    const branch = src.slice(
        src.indexOf('shouldAnnounceStallTruncation({'),
        src.indexOf('const { message: errMsg } = classifyExitError('),
    );
    assert.ok(branch.length > 0, 'the announce branch must exist');

    // ctx.fullText feeds resolve() and therefore every channel reply.
    assert.match(branch, /ctx\.fullText = `\$\{ctx\.fullText\}[\s\S]*stallNotice/);

    // And resolve() must still be handing back ctx.fullText, or the line above
    // is guarding a path that no longer carries the reply.
    assert.match(src, /resolve\(\{\s*\n?\s*text: ctx\.fullText/);
});
// The notice is written for a person reading a reply. Anything the MACHINE reads
// back later must not carry it: in P the reply text becomes the authoritative
// plan, persisted to the worklog and re-injected as the next turn's Approved
// Plan — where "시간이 초과되어 여기서 중단했습니다" reads as an instruction (#405).
test('LEB-008: the notice is stripped from anything read back as a plan', async () => {
    const { stripStallTruncationNotice } = await import('../../src/agent/error-classifier.ts');

    const plan = '1. 조사한다\n2. 정리한다';
    assert.equal(stripStallTruncationNotice(`${plan}\n\n${STALL_TRUNCATION_NOTICE}`), plan);
    // Untouched when it is not there, and no accidental trimming of real text.
    assert.equal(stripStallTruncationNotice(plan), plan);
    assert.equal(stripStallTruncationNotice(''), '');

    // Only the suffix we appended, and only at the end. Deleting every
    // occurrence ate the sentence out of a plan that quoted it, and a bare
    // trimEnd() took meaningful Markdown trailing spaces with it.
    const quoting = `Plan: quote "${STALL_TRUNCATION_NOTICE}" then document it.`;
    assert.equal(stripStallTruncationNotice(quoting), quoting, 'a quoted notice is content, not our suffix');
    const twoSpaces = 'line one  \nline two  ';
    assert.equal(stripStallTruncationNotice(twoSpaces), twoSpaces, 'Markdown line breaks survive');
    assert.equal(
        stripStallTruncationNotice(`${twoSpaces}\n\n${STALL_TRUNCATION_NOTICE}`), twoSpaces,
        'removing the suffix leaves the rest byte-identical',
    );
});

test('LEB-009: the P-phase plan save runs the text through that strip', () => {
    const src = readFileSync(
        join(import.meta.dirname, '..', '..', 'src/orchestrator/pipeline.ts'), 'utf8',
    );
    const planSave = src.slice(
        src.indexOf("if (state === 'P' && !meta[\"_workerResult\"])"),
        src.indexOf('// Final safety strip'),
    );
    assert.ok(planSave.length > 0, 'the P-phase plan save must exist');
    assert.match(planSave, /stripStallTruncationNotice\(/);
    // And the stripped value is what newPlan is built from, not a parallel var.
    assert.match(planSave, /const newPlan = stripSubtaskJSON\(planText\)/);
});

// Durable history is read back by the next turn, the resume fallback, AGY
// replay, memory flush and compaction. A line telling a PERSON we ran out of
// time reads as an instruction in every one of them, so it must never be stored
// — stripping it downstream only covers the paths someone remembered (#405).
// Two readers of the same row want opposite things, and both were got wrong in
// turn. A PERSON reopening the transcript must still see that the turn was cut
// short — leaving the notice out of storage made it vanish on refresh, which is
// the original complaint. A MODEL replaying that row as prior context must not
// see it, or a sentence addressed to a person comes back as an instruction.
//
// So it is stored, and removed at the history-replay query boundary (#405).
test('LEB-010: a stored notice survives for the reader and is stripped for replay', async () => {
    const { getRecentMessages, getRecentMessagesLite, insertMessage, db } =
        await import('../../src/core/db.ts');
    const { STALL_TRUNCATION_NOTICE: NOTICE } = await import('../../src/agent/stall-notice.ts');

    const sessionId = `leb010-${Date.now()}`;
    const body = 'partial answer that stopped mid-thought';
    try {
        insertMessage.run('assistant', `${body}\n\n${NOTICE}`, 'cursor', '', null, sessionId);

        // Replay readers: the notice is gone, the answer is not.
        for (const reader of [getRecentMessages, getRecentMessagesLite]) {
            const rows = reader.all(null, sessionId, 5) as Array<{ content?: string }>;
            const row = rows.find(r => typeof r.content === 'string' && r.content.includes(body));
            assert.ok(row, 'the row must come back');
            assert.equal(row!.content, body, 'replay context must not carry a line meant for a person');
        }

        // The transcript reader is the raw row, which still has it.
        const raw = db.prepare('SELECT content FROM messages WHERE session_id = ?')
            .get(sessionId) as { content: string };
        assert.ok(raw.content.endsWith(NOTICE), 'refresh must still show the turn was cut short');
    } finally {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    }
});

// The query boundary covers the history readers, and compact does not use them
// for this slot: it greps the messages table directly, and the notice came back
// through grep_hits with everything else green (#405).
test('LEB-011: compaction does not reintroduce the notice through its grep slot', async () => {
    const { insertMessage, db } = await import('../../src/core/db.ts');
    const { STALL_TRUNCATION_NOTICE: NOTICE } = await import('../../src/agent/stall-notice.ts');
    const { harvestBootstrapSlots } = await import('../../src/core/compact.ts');

    const sessionId = `leb011-${Date.now()}`;
    // A distinctive keyword so the grep slot has something to match on.
    const body = 'zephyrite calibration notes for the harvest';
    try {
        insertMessage.run('user', 'zephyrite calibration 조사해줘', 'web', '', null, sessionId);
        insertMessage.run('assistant', `${body}\n\n${NOTICE}`, 'cursor', '', null, sessionId);

        const slots = harvestBootstrapSlots({ workingDir: null, chatSessionId: sessionId });
        const everything = Object.values(slots).map(v => String(v ?? '')).join('\n');
        assert.ok(
            !everything.includes(NOTICE),
            'no bootstrap slot may carry a line addressed to a person',
        );
    } finally {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    }
});
