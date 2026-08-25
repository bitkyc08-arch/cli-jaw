// #451: slash commands ran outside the session that issued them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { withSessionScope } from '../../src/core/session-context.ts';
import { sessionScopeMeta } from '../../src/cli/session-scope-meta.ts';

const root = join(import.meta.dirname, '../..');

test('SLASH-451a: the helper reports the scope of the surrounding session', () => {
    const meta = withSessionScope(
        { scope: 'local:tab-7', chatSessionId: 'tab-7' } as never,
        () => sessionScopeMeta(),
    );
    assert.deepEqual(meta, { scope: 'local:tab-7', chatSessionId: 'tab-7' });
});

test('SLASH-451b: outside any session it contributes nothing', () => {
    // Spreading {} leaves submitMessage on its existing resolution path, which is
    // the right answer when multi-session is off.
    assert.deepEqual(sessionScopeMeta(), {});
});

test('SLASH-451c: every slash handler that submits a turn carries the session', () => {
    // Missing one leaves that command running in 'default' — queued behind
    // unrelated work and outside its own PABCD lane — while its message is
    // recorded in the tab's session. The split is invisible until a second
    // session is busy.
    for (const file of [
        'src/cli/handlers-search.ts',
        'src/cli/handlers-workflows.ts',
        'src/cli/handlers-skill-invoke.ts',
        'src/cli/handlers-runtime.ts',
    ]) {
        const src = fs.readFileSync(join(root, file), 'utf8');
        const calls = src.match(/submitMessage\([^)]*\)/gs) || [];
        assert.ok(calls.length > 0, `${file} should still submit a turn`);
        for (const call of calls) {
            assert.match(call, /sessionScopeMeta\(\)/,
                `${file} submits without the session: ${call.slice(0, 120)}`);
        }
    }
});

