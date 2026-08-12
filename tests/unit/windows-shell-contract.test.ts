// #302 / #310: the Windows shell rules have to live where they are needed.
//
// A prior cycle recorded them in the repo's AGENTS.md, which guides agents
// DEVELOPING cli-jaw. The agent cli-jaw DISPATCHES onto a user's Windows host
// never reads that file, so both prompts carry the invariant now.
//
// The shipped .ps1 assertions are the code half: cli-jaw does author
// PowerShell — two installers are checked in and published — and one of them
// prints non-ASCII symbols that PowerShell 5.1 corrupts without a BOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Boss gets a1-system.md; a dispatched worker gets employee.md. A rule in only
// one of them is invisible to half the agents that write scripts.
const PROMPTS = ['src/prompt/templates/a1-system.md', 'src/prompt/templates/employee.md'];

for (const prompt of PROMPTS) {
    test(`WSC-001 (${path.basename(prompt)}): requires a UTF-8 BOM for .ps1`, () => {
        const src = read(prompt);
        assert.match(src, /\.ps1/, 'the rule must name the file type it applies to');
        assert.match(src, /BOM/, 'the BOM requirement must be stated');
        assert.match(src, /CP949|ANSI code page/, 'the actual corruption mechanism must be named');
    });

    test(`WSC-002 (${path.basename(prompt)}): gives LEN as the diagnostic`, () => {
        // Console garbling and in-memory corruption look identical in a
        // terminal; length is the only signal that separates them.
        assert.match(read(prompt), /LEN/, 'the length check must be the stated discriminator');
    });

    test(`WSC-003 (${path.basename(prompt)}): names all three shells and DefaultShell`, () => {
        const src = read(prompt);
        assert.match(src, /powershell\.exe|PowerShell 5\.1|`powershell\.exe`/i);
        assert.match(src, /pwsh\.exe/i);
        assert.match(src, /Git Bash/i);
        assert.match(src, /DefaultShell/, 'the registry key that decides the shell must be named');
    });

    test(`WSC-004 (${path.basename(prompt)}): warns that a nested outer shell expands variables first`, () => {
        assert.match(read(prompt), /outer/i);
    });
}

// The shipped installers are the concrete #302 exposure: they are published in
// the npm artifact and run by PowerShell on the user's machine.
const SHIPPED_PS1 = ['scripts/install.ps1', 'scripts/install-officecli.ps1'];

for (const rel of SHIPPED_PS1) {
    test(`WSC-005 (${path.basename(rel)}): begins with a UTF-8 BOM`, () => {
        const raw = fs.readFileSync(path.join(ROOT, rel));
        assert.deepEqual(
            [...raw.subarray(0, 3)],
            [0xef, 0xbb, 0xbf],
            `${rel} must start with EF BB BF or PowerShell 5.1 decodes it as the ANSI code page`,
        );
    });

    test(`WSC-006 (${path.basename(rel)}): stays valid UTF-8 after the BOM`, () => {
        const raw = fs.readFileSync(path.join(ROOT, rel));
        assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(3)));
    });
}

test('WSC-007: the installer keeps its non-ASCII status symbols intact', () => {
    // These are why the BOM matters here rather than being cosmetic: under
    // CP949 the check mark decodes to a different character entirely.
    const src = read('scripts/install-officecli.ps1');
    for (const symbol of ['▸', '✔', '⚠', '✖']) {
        assert.ok(src.includes(symbol), `missing status symbol ${symbol}`);
    }
});
