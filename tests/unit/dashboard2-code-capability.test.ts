import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import test from 'node:test';
import { probeCodeCapabilities } from '../../src/code-mode/acp-host.ts';
import { fetchCodeCapabilities } from '../../public/dashboard2/src/code/code-capability-client.ts';
import { CODE_SUBAGENT_CONTROL_LEVEL } from '../../public/dashboard2/src/code/code-subagent-capabilities.ts';

const codeRoot = new URL('../../public/dashboard2/src/code/', import.meta.url);

function readCodeSources(): Array<{ path: string; source: string }> {
    const root = codeRoot.pathname;
    const files: string[] = [];
    const visit = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (['.ts', '.tsx'].includes(extname(entry.name))) files.push(path);
        }
    };
    visit(root);
    return files.map(path => ({ path, source: readFileSync(path, 'utf8') }));
}

test('061 capability probe returns a bounded missing-binary response', async () => {
    const previous = process.env['JWC_ACP_CMD'];
    process.env['JWC_ACP_CMD'] = '/nonexistent-binary-for-test --mode acp';
    try {
        const result = await probeCodeCapabilities({ refresh: true });
        assert.deepEqual(result, {
            available: false,
            reason: 'missing_binary',
            commandSource: 'env',
        });
        const allowedKeys = new Set(['available', 'reason', 'commandSource', 'acpProtocolVersion']);
        assert.equal(Object.keys(result).every(key => allowedKeys.has(key)), true);
        assert.equal(
            ['ok', 'missing_binary', 'acp_unsupported', 'temporarily_unavailable'].includes(result.reason),
            true,
        );
    } finally {
        if (previous === undefined) delete process.env['JWC_ACP_CMD'];
        else process.env['JWC_ACP_CMD'] = previous;
    }
});

test('061 capability client maps success, failures, unknown reasons, and refresh URLs', async () => {
    const previous = globalThis.fetch;
    const calls: string[] = [];
    const responses = [
        { ok: true, json: async () => ({ ok: true, available: true, reason: 'ok', commandSource: 'path' }) },
        { ok: false, json: async () => ({}) },
        { ok: true, json: async () => ({ ok: true, available: true, reason: 'future_reason' }) },
        { ok: true, json: async () => ({ ok: true, available: true, reason: 'ok' }) },
    ];
    globalThis.fetch = (async (input: string | URL | Request) => {
        calls.push(String(input));
        return responses.shift() as Response;
    }) as typeof fetch;
    try {
        assert.deepEqual(await fetchCodeCapabilities(3458), {
            available: true,
            reason: 'ok',
            commandSource: 'path',
        });
        assert.deepEqual(await fetchCodeCapabilities(3458), {
            available: false,
            reason: 'temporarily_unavailable',
        });
        assert.deepEqual(await fetchCodeCapabilities(3458), {
            available: false,
            reason: 'temporarily_unavailable',
        });
        assert.deepEqual(await fetchCodeCapabilities(3458, { refresh: true }), {
            available: true,
            reason: 'ok',
        });
        assert.equal(calls.at(-1), '/i/3458/api/code/capabilities?refresh=1');
    } finally {
        globalThis.fetch = previous;
    }
});

test('061 Code gate is the lazy public entry and exposes bounded reason states', () => {
    const gate = readFileSync(new URL('../../public/dashboard2/src/code/CodeTabGate.tsx', import.meta.url), 'utf8');
    const index = readFileSync(new URL('../../public/dashboard2/src/code/index.ts', import.meta.url), 'utf8');
    assert.match(gate, /lazy\(\(\) => import\('\.\/CodeTab\.tsx'\)\)/);
    assert.match(gate, /data-state=\{state\.reason\}/);
    for (const reason of ['missing_binary', 'acp_unsupported', 'temporarily_unavailable']) {
        assert.match(gate, new RegExp(`\\b${reason}\\b`));
    }
    assert.match(index, /export \{ CodeTabGate, default \} from '\.\/CodeTabGate\.tsx';/);
    assert.doesNotMatch(index, /^import(?!\s+type)[^;]*['"]\.\/CodeTab\.tsx['"]/m);
});

test('061 D16 keeps Code subagent controls read-only', () => {
    assert.equal(CODE_SUBAGENT_CONTROL_LEVEL, 'read-only');
    for (const { path, source } of readCodeSources()) {
        assert.doesNotMatch(source, /\b(pause|resume)\w*\s*\(/i, path);
    }
});
