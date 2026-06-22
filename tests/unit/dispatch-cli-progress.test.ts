import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

test('dispatch CLI prints employee process summary from returned tools', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'commands', 'dispatch.ts'), 'utf8');
    assert.match(src, /--- Employee Process ---/);
    assert.match(src, /--- Employee Process \(live\) ---/);
    assert.match(src, /function\s+resultTools/);
    assert.match(src, /const quiet = process\.argv\.includes\('--quiet'\)/);
    assert.match(src, /const json = process\.argv\.includes\('--json'\)/);
    assert.match(src, /wait:\s*false/);
    assert.match(src, /pollAndPrintWorker/);
    assert.match(src, /function\s+shouldPrintLiveProgress/);
    assert.match(src, /return !json && !quiet/);
    assert.match(src, /res\.status === 202/);
    assert.match(src, /displayShellCommand/);
    assert.match(src, /displayShellCommandDetail/);
    assert.match(src, /progressRun\(body\.progress\)\?\.tools/);
});

test('dispatch CLI defaults to safe live progress and keeps quiet/json paths quiet', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'commands', 'dispatch.ts'), 'utf8');

    assert.match(src, /const liveProgress = shouldPrintLiveProgress\(\)/);
    assert.match(src, /liveProgress\s*\?\s*await pollAndPrintWorker/);
    assert.match(src, /:\s*await pollWorkerResult/);
    assert.match(src, /if \(json\) printJsonResult\(polled\)/);
    assert.match(src, /if \(!json && !quiet\) console\.log\(`🚀 Dispatching to/);
    assert.match(src, /--quiet\s+Suppress live progress summaries/);
    assert.match(src, /--json\s+JSON output; suppresses human progress lines/);
});
