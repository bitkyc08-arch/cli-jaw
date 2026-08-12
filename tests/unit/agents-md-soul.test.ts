// Isolation MUST be the first import: this test writes soul.md into the memory
// tree under CLI_JAW_HOME, and the runner shares one home across concurrently
// running files (#288). Its own home keeps that write from reaching siblings.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { getSoulPath } from '../../src/memory/identity.ts';
import { getSystemPrompt } from '../../src/prompt/builder.ts';

// #300: buildPrompt(forDisk) generates AGENTS.md and its own comment said the
// block exists "so Codex/OpenCode sessions have soul, profile, and snapshot
// context" — but it only ever appended profile and snapshot. On a codex-app
// host the agent's configured identity was absent from the prompt entirely and
// it ran on shipped defaults, with nothing in the output to show the loss.

const SOUL_BODY = 'IDENTITY-MARKER-7f3a: operator prefers terse answers and no emoji.';

function writeSoul(body: string): void {
    const p = getSoulPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
}

test('AGENTS.md carries soul.md, not just profile and snapshot', () => {
    writeSoul(SOUL_BODY);
    const prompt = getSystemPrompt({ forDisk: true });

    assert.match(prompt, /## Disk Memory Context/, 'the disk prompt should emit its bounded memory block');
    assert.match(prompt, /## Soul & Identity/, 'soul content should be explicitly labelled');
    assert.ok(
        prompt.includes(SOUL_BODY),
        'soul.md content must reach the generated AGENTS.md — this is the whole of #300',
    );
});

test('a host with no soul.md generates the same prompt as before', () => {
    // readSoul() returns '' for a missing file, so an unconfigured host must be
    // untouched by the fix: no stray heading, no empty Core Memory block.
    // Tests share a process, so clear what the previous case wrote.
    rmSync(getSoulPath(), { force: true });
    const prompt = getSystemPrompt({ forDisk: true });
    assert.ok(!prompt.includes(SOUL_BODY), 'a removed soul must not linger in the generated prompt');
    assert.ok(!/## Core Memory\s*\n\s*\n*---/.test(prompt), 'no empty Core Memory block on an unconfigured host');
});

test('an oversized soul is bounded rather than pasted whole', () => {
    // AGENTS.md is read on every turn, so an unbounded identity file would tax
    // the context window forever. readSoul() itself is unbounded by design — the
    // API surface serves it in full — so the budget lives at this boundary.
    const huge = 'X'.repeat(7000);
    writeSoul(huge);
    const prompt = getSystemPrompt({ forDisk: true });

    const run = prompt.match(/X{50,}/)?.[0] ?? '';
    assert.ok(run.length > 0, 'the oversized soul should still appear');
    assert.ok(
        run.length <= 6000,
        `soul must be truncated to the disk budget, saw ${run.length} chars`,
    );
});
