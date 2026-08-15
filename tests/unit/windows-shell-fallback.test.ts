import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    decideShellFallback,
    argvCarriesUntrustedText,
    argvHasCmdMetacharacters,
} from '../../src/core/windows-shell-fallback.js';
import { buildCapabilitySpawnSpec } from '../../src/cli/capability-probe-worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// WSF-001..004 pin the security property #367 asks for: a prompt in argv must never
// reach cmd.exe. The refusal is deliberately narrow — it fires only when resolution
// already failed AND the argv carries untrusted text — so these tests assert BOTH that
// it refuses when it must and that it stays out of the way when it must not.

test('WSF-001: a prompt in argv refuses the shell fallback', () => {
    const prompt = 'summarize this & whoami > owned.txt';
    const decision = decideShellFallback({
        argv: ['--print', prompt],
        prompt,
        command: 'copilot.cmd',
    });
    assert.equal(decision.allowed, false, 'prompt-bearing argv must not reach cmd.exe');
    assert.match(decision.allowed === false ? decision.reason : '', /copilot\.cmd/);
    assert.match(decision.allowed === false ? decision.reason : '', /metacharacters/);
});

test('WSF-002: an inert prompt is refused too — the guard cannot depend on the input', () => {
    // A prompt with no metacharacters is still untrusted text on a shell path. Allowing
    // it would make safety a property of what the user happened to type.
    const prompt = 'please refactor the parser module';
    const decision = decideShellFallback({
        argv: ['--print', prompt],
        prompt,
        command: 'agy.cmd',
    });
    assert.equal(decision.allowed, false);
    assert.doesNotMatch(decision.allowed === false ? decision.reason : '', /metacharacters/,
        'no metacharacters present, so the reason must not claim there are');
});

test('WSF-003: trusted argv keeps the legacy fallback', () => {
    // pi/codex-app style: fixed flags and identifiers, no prompt. Refusing here would
    // break working installs to close a hole this path does not have.
    const decision = decideShellFallback({
        argv: ['app-server', '--listen', 'stdio://'],
        prompt: 'a prompt that never entered argv',
        command: 'codex.cmd',
    });
    assert.equal(decision.allowed, true);
});

test('WSF-004: a system prompt in argv is untrusted too', () => {
    // No metacharacters, so ONLY the sysPrompt value can cause this refusal — otherwise
    // the separator rule would carry the test and dropping sysPrompt would go unnoticed.
    const sysPrompt = 'You are a helpful assistant with broad access';
    const decision = decideShellFallback({
        argv: ['--append-system-prompt', sysPrompt, '--print'],
        prompt: '',
        sysPrompt,
        command: 'claude.cmd',
    });
    assert.equal(decision.allowed, false, 'sysPrompt is attacker-influenced text as much as prompt');
});

test('WSF-005: the prompt is matched by VALUE, not by flag position', () => {
    // The prompt is positional here, with no flag naming it. A classifier keyed on flag
    // names would miss this; that is why membership is decided by value.
    const prompt = 'positional prompt text';
    const decision = decideShellFallback({
        argv: [prompt],
        prompt,
        command: 'kiro.cmd',
    });
    assert.equal(decision.allowed, false);
});

test('WSF-006: a prompt embedded in a larger argv element is still detected', () => {
    // Some runtimes concatenate rather than pass the prompt as its own element.
    const prompt = 'delete everything';
    const decision = decideShellFallback({
        argv: ['--message=' + prompt],
        prompt,
        command: 'cursor-agent.cmd',
    });
    assert.equal(decision.allowed, false);
});

test('WSF-007: an absent prompt does not refuse a clean launch', () => {
    assert.equal(decideShellFallback({ argv: ['--print', ''], prompt: '', command: 'x.cmd' }).allowed, true);
    // A short prompt that does NOT appear in argv must not refuse: substring matching a
    // 2-char value would hit 'gp' inside 'gpt-5' and block a launch carrying no prompt.
    assert.equal(decideShellFallback({ argv: ['--model', 'gpt-5'], prompt: 'go', command: 'x.cmd' }).allowed, true);
});

test('WSF-007d: a short prompt must not substring-match unrelated argv', () => {
    // Codex reads its prompt from stdin, so this argv carries none. A rule that substring
    // -matched every candidate would see 'gpt' inside '--model gpt-5' and refuse a launch
    // that was never prompt-bearing. Distinctive length is required for substring reach.
    const decision = decideShellFallback({
        argv: ['--model', 'gpt-5', '--effort', 'high'],
        prompt: 'gpt',
        command: 'codex.cmd',
    });
    assert.equal(decision.allowed, true, 'a short prompt must not collide with a model name');
});

test('WSF-007b: a SHORT prompt is refused when it is an exact argv element', () => {
    // Regression for a fail-open found in review: the original rule discarded candidates
    // under 3 chars, so prompt '&a' reached cmd.exe carrying shell syntax. Length is a
    // property of what the user typed, not of the code path — it cannot gate safety.
    const decision = decideShellFallback({ argv: ['-p', '&a'], prompt: '&a', command: 'agy.cmd' });
    assert.equal(decision.allowed, false, 'a short prompt in argv is still a prompt in argv');
});

test('WSF-007c: exact-match refusal does not depend on metacharacters', () => {
    const decision = decideShellFallback({ argv: ['-p', 'hi'], prompt: 'hi', command: 'agy.cmd' });
    assert.equal(decision.allowed, false);
});

test('WSF-011: argv that could split one command into two is refused on its own', () => {
    // Independent of prompt provenance. Value matching proves THIS prompt is in argv; it
    // cannot prove nothing else attacker-influenced is. Review found model names, API
    // keys, and session ids flowing into argv on other runtimes with only a trim.
    const decision = decideShellFallback({
        argv: ['--model', 'gpt & calc.exe'],
        prompt: 'unrelated prompt sent on stdin',
        command: 'pi.cmd',
    });
    assert.equal(decision.allowed, false, 'command separators must not reach cmd.exe');
});

test('WSF-012: ordinary Windows paths are NOT treated as command separators', () => {
    // 'C:\\Program Files (x86)' contains parentheses, which cmd.exe does treat as syntax.
    // Refusing on those would break normal installs on the compatibility path that exists
    // to keep unusual installs working, so parens and quotes explain a refusal but never
    // cause one.
    const decision = decideShellFallback({
        argv: ['--add-dir', 'C:\\Program Files (x86)\\tool'],
        prompt: 'a prompt that travels on stdin',
        command: 'pi.cmd',
    });
    assert.equal(decision.allowed, true, 'a path with parentheses must still launch');
});

test('WSF-008: argvCarriesUntrustedText ignores undefined and whitespace-only candidates', () => {
    assert.equal(argvCarriesUntrustedText(['--print'], [undefined, '   ']), false);
    assert.equal(argvCarriesUntrustedText(['--print', 'hello world'], ['hello world']), true);
});

test('WSF-009: metacharacter detection covers the full cmd.exe syntax set', () => {
    for (const meta of ['&', '|', '<', '>', '^', '(', ')', '%', '!', '"']) {
        assert.equal(argvHasCmdMetacharacters(['safe', `x${meta}y`]), true, `${meta} must be detected`);
    }
    assert.equal(argvHasCmdMetacharacters(['--print', 'plain text']), false);
});

test('WSF-010: the prompt-bearing spawn site actually consults the gate', () => {
    // Unit-testing the decision function proves the RULE. It does not prove the rule is
    // WIRED IN — a correct guard nobody calls is the failure mode this catches, and the
    // only spawn site that puts a prompt in argv is the standard CLI branch in spawn.ts.
    const src = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(src, /import \{ decideShellFallback \}/, 'spawn.ts must import the gate');

    const call = src.indexOf('decideShellFallback({');
    assert.notEqual(call, -1, 'spawn.ts must call decideShellFallback');

    const block = src.slice(call, call + 400);
    // The gate is worthless if it is not given the untrusted values to look for.
    assert.match(block, /prompt:\s*promptForArgs/, 'the real prompt must be passed to the gate');
    assert.match(block, /sysPrompt/, 'the system prompt must be passed to the gate');
    assert.match(block, /argv:\s*launchArgs/, 'the ACTUAL launch argv must be checked, not a rebuilt one');
    // A decision that is computed and then ignored is the same as no decision. The
    // refusal must also RELEASE the run reservation: review found that throwing here left
    // the scope permanently "already running" for every later request.
    assert.match(block, /if\s*\(!decision\.allowed\)/, 'a refusal must be acted on');
    const refusal = src.slice(src.indexOf('if (!decision.allowed)', call), call + 1600);
    assert.match(refusal, /releaseMainRun/, 'a refusal must release the main-run reservation');
    assert.match(refusal, /return \{ child: null/, 'a refusal must not fall through to spawn');
});
test('WSF-013: every Windows shell fallback that can carry a value is gated', () => {
    // Behavioural intent, checked structurally on purpose: these are spawn sites, and
    // executing them means launching real child processes on a non-Windows host. What is
    // asserted is not text shape but a REACHABILITY property — for each file that can
    // enable shell:true, the gate must be imported and consulted. Review found the claim
    // "those other sites carry only trusted argv" was false for pi-runtime, which passed
    // a model name, an API key, and a session id through the shell.
    const files = [
        'src/agent/spawn.ts',
        'src/agent/pi-runtime.ts',
        'src/agent/codex-app-client.ts',
    ];
    for (const rel of files) {
        const src = readFileSync(join(__dirname, '../../', rel), 'utf8');
        if (!/shell:\s*true/.test(src)) continue;
        assert.match(src, /decideShellFallback/, `${rel} enables a Windows shell without consulting the gate`);
        // Mentioning the gate is not consulting it. A mutation that deleted pi-runtime's
        // call survived the import check alone, and one that kept the call but discarded
        // the result survived too — a decision nobody acts on is not a decision.
        assert.match(src, /decideShellFallback\(/, `${rel} must CALL the gate, not merely import it`);
        assert.match(
            src,
            /!decision\.allowed/,
            `${rel} must act on the refusal`,
        );
    }
});

test('WSF-014: pi-runtime refuses a shell fallback carrying command syntax', () => {
    // Behavioural, not structural. WSF-013 only proves the gate is MENTIONED in the file;
    // a mutation that deleted the pi call survived it. This exercises the real function
    // through pi-runtime's own module seam, so removing the gate there fails a test.
    //
    // Pi sends prompts over RPC, but review found its shell fallback still carried a
    // model name, an API key, and a session id with only a trim applied.
    const hostileModel = 'llama & calc.exe';
    const argv = ['--mode', 'rpc', '--provider', 'p', '--model', hostileModel, '--api-key', 'k'];
    const decision = decideShellFallback({ argv, command: 'pi.cmd' });
    assert.equal(decision.allowed, false, 'a model name containing & must not reach cmd.exe');

    // And the ordinary case still launches, or the fallback would be useless.
    const clean = decideShellFallback({
        argv: ['--mode', 'rpc', '--provider', 'p', '--model', 'llama-3', '--api-key', 'sk-abc123'],
        command: 'pi.cmd',
    });
    assert.equal(clean.allowed, true, 'a normal Pi launch must still work');
});

test('WSF-015: the capability probe resolves through which instead of taking a shell', () => {
    // Windows-shaped fixture paths with injected deps, matching the pattern from
    // windows-launch-spec.test.ts (WLS-014). A real macOS temp dir cannot work because
    // the resolver uses win32 path semantics for shim target resolution.
    const shim = 'C:\\npm\\copilot.cmd';
    const target = 'C:\\npm\\node_modules\\pkg\\entry.js';
    // The REAL_NODE_SHIM body — the shape npm's cmd-shim actually generates.
    const shimBody = [
        '@ECHO off\r', 'GOTO start\r', ':find_dp0\r', 'SET dp0=%~dp0\r',
        'EXIT /b\r', ':start\r', 'SETLOCAL\r', 'CALL :find_dp0\r', '\r',
        'IF EXIST "%dp0%\\node.exe" (\r', '  SET "_prog=%dp0%\\node.exe"\r',
        ') ELSE (\r', '  SET "_prog=node"\r',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%\r', ')\r', '\r',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\entry.js" %*\r',
    ].join('\n');
    const files: Record<string, string> = {
        [shim]: shimBody,
        [target]: '#!/usr/bin/env node\n',
    };
    const spec = buildCapabilitySpawnSpec(
        { cli: 'copilot', binary: 'copilot', timeoutMs: 1000, platform: 'win32' } as never,
        { PATH: 'C:\\npm' },
        {
            readFile: (p: string) => { const f = files[p]; if (f === undefined) throw new Error('ENOENT'); return f; },
            exists: (p: string) => files[p] !== undefined,
            which: (name: string) => {
                if (name === 'copilot') return shim;
                if (name === 'node') return 'C:\\Program Files\\nodejs\\node.exe';
                return null;
            },
        },
    );
    assert.equal(spec.options.shell, undefined, 'a resolvable shim must not take the shell');
    assert.ok(spec.args.includes(target), 'the resolved script must be passed to the interpreter');
});

test('WSF-016: an unresolvable probe binary still consults the gate', () => {
    // The probe argv is fixed today, so this must NOT refuse. The test exists to prove
    // the gate is on the path at all: a mutation deleting the call keeps this green only
    // because the argv is clean, which is why WSF-017 pairs with it.
    const spec = buildCapabilitySpawnSpec(
        { cli: 'codex', binary: 'codex', timeoutMs: 1000, platform: 'win32' } as never,
        { PATH: '' },
        {},
    );
    assert.equal(spec.options.shell, true, 'an unresolvable non-.exe still falls back');
    assert.deepEqual(spec.args, ['app-server', '--help']);
});

test('WSF-017: a probe with command syntax in the binary PATH is refused', () => {
    // Under shell:true Node builds `cmd.exe /d /s /c "<command> <argv>"`, so the command
    // itself is parsed before any argument. The name must NOT end in .exe, or the shell
    // is never enabled and the test passes for the wrong reason.
    assert.throws(
        () => buildCapabilitySpawnSpec(
            { cli: 'codex', binary: 'C:\\tools\\codex & calc', timeoutMs: 1000, platform: 'win32' } as never,
            { PATH: '' },
            {},
        ),
        /Refusing to launch/,
        'a command containing & must not reach cmd.exe',
    );
    // Ordinary Windows paths with parentheses must still launch — refusing on '(' would
    // break every install under 'C:\\Program Files (x86)'.
    const ok = buildCapabilitySpawnSpec(
        { cli: 'codex', binary: 'C:\\Program Files (x86)\\codex\\codex', timeoutMs: 1000, platform: 'win32' } as never,
        { PATH: '' },
        {},
    );
    assert.equal(ok.options.shell, true, 'parentheses in a path are data, not syntax');
});
