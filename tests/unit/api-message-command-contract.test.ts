import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// /api/message lives in routes/command.ts since the Phase 2 extraction.
const serverSrc = fs.readFileSync(path.join(__dirname, '../../src/routes/command.ts'), 'utf8');

function routeBlock(route: string): string {
    const start = serverSrc.indexOf(route);
    assert.ok(start >= 0, `${route} route missing`);
    const next = serverSrc.indexOf("app.post('", start + route.length);
    return serverSrc.slice(start, next > start ? next : undefined);
}

test('/api/message slash command errors fail closed instead of falling through to agent prompt', () => {
    const block = routeBlock("app.post('/api/message'");
    // logger migration (WP4): the catch logs via log.error (level-aware wrapper over console.error)
    const catchStart = block.indexOf("log.error('[api/message:cmd]'");
    const submitStart = block.indexOf('const result = submitMessage(trimmed');
    assert.ok(catchStart > 0, 'slash command catch block missing');
    assert.ok(submitStart > catchStart, 'normal message submit path should remain after slash handling');
    const catchBlock = block.slice(catchStart, submitStart);
    // The error text is masked before it leaves the process: an executor can
    // throw with a bot token in the message, and this body is returned to an
    // unauthenticated-by-default local caller. `userErrorText` is what makes
    // the 500 safe to show, so the contract is the masked form, not the raw
    // `error` binding this assertion used to require.
    assert.match(catchBlock, /res\.status\(500\)\.json\(\{ ok: false, command: true, error: userErrorText\(err\) \}\);/);
    assert.match(catchBlock, /log\.error\('\[api\/message:cmd\]', logErrorText\(err\)\)/,
        'the log sink must be masked too');
    assert.match(catchBlock, /return;/);
});

test('/api/message slash steerPrompt rejects visibly when submitMessage rejects', () => {
    const block = routeBlock("app.post('/api/message'");
    const steerStart = block.indexOf('if (cmdResult?.steerPrompt)');
    const normalStart = block.indexOf('const result = submitMessage(trimmed');
    assert.ok(steerStart >= 0 && normalStart > steerStart, 'steerPrompt branch should precede normal submit');
    const steerBlock = block.slice(steerStart, normalStart);
    // wp1: the submit meta may carry _steerContext from the interrupted turn;
    // the contract is that steering goes through submitMessage with the shared meta.
    assert.match(steerBlock, /const submit = submitMessage\(cmdResult\.steerPrompt, \{/);
    assert.match(steerBlock, /\.\.\.submitMeta/);
    assert.match(steerBlock, /submit\.action === 'rejected'/);
    assert.match(steerBlock, /res\.status\(status\)\.json\(\{ ok: false, command: true, error: submit\.reason, \.\.\.publicSubmitResult\(submit\) \}\);/);
});

test('/api/message projects all five SubmitResult response branches', () => {
    const messageBlock = routeBlock("app.post('/api/message'");
    assert.equal((messageBlock.match(/publicSubmitResult\(/g) || []).length, 4,
        'normal success/rejection and command steer success/rejection must project');
    assert.doesNotMatch(messageBlock, /\.\.\.(?:result|submit)\b/);

    const elicitationBlock = routeBlock("app.post('/api/elicitation/callback'");
    assert.equal((elicitationBlock.match(/publicSubmitResult\(submit\)/g) || []).length, 1,
        'elicitation completion must project');
});
