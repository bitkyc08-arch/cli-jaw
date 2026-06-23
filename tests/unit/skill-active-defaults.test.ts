import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { OPENCLAW_ACTIVE } from '../../lib/mcp/skills-utils.js';

function makeSkill(root: string, id: string, body = `---\nname: ${id}\ndescription: ${id} skill\n---\n`): void {
    const dir = join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'SKILL.md'), body);
}

function makeRegistry(root: string, ids: string[]): void {
    const skills = Object.fromEntries(ids.map(id => [id, { version: '1.0.0' }]));
    fs.writeFileSync(join(root, 'registry.json'), JSON.stringify({ skills }, null, 2));
}

function runNodeEval(code: string, env: NodeJS.ProcessEnv): string {
    return execFileSync(process.execPath, ['--import', 'tsx', '--eval', code], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

test('active defaults include search, structured-renderers, and goal', () => {
    assert.equal(OPENCLAW_ACTIVE.has('search'), true);
    assert.equal(OPENCLAW_ACTIVE.has('structured-renderers'), true);
    assert.equal(OPENCLAW_ACTIVE.has('goal'), true);
});

test('propagation activates defaults from instance skills_ref and preserves custom active skills', () => {
    const home = fs.mkdtempSync(join(os.tmpdir(), 'jaw-active-defaults-home-'));
    try {
        const base = join(home, '.cli-jaw');
        const baseRef = join(base, 'skills_ref');
        const baseActive = join(base, 'skills');
        const inst = join(home, '.cli-jaw-3458');
        const instActive = join(inst, 'skills');

        fs.mkdirSync(baseRef, { recursive: true });
        fs.mkdirSync(baseActive, { recursive: true });
        fs.mkdirSync(instActive, { recursive: true });

        const refIds = ['search', 'structured-renderers', 'goal'];
        makeRegistry(baseRef, refIds);
        for (const id of refIds) {
            makeSkill(baseRef, id, `---\nname: ${id}\ndescription: ${id} from ref\n---\n`);
        }
        makeSkill(baseActive, 'search', 'active search should not be copied when ref exists\n');
        makeSkill(baseActive, 'base-only', 'base-only fallback\n');
        makeSkill(instActive, 'custom-local', 'custom local skill\n');

        runNodeEval(`
            const { OPENCLAW_ACTIVE } = await import('./lib/mcp/skills-utils.ts');
            OPENCLAW_ACTIVE.add('base-only');
            const { propagateSkillsToInstances } = await import('./lib/mcp/skills-distribution.ts');
            propagateSkillsToInstances();
        `, {
            HOME: home,
            CLI_JAW_HOME: base,
            JAW_FORCE_CLONE: '1',
            JAW_SKILLS_SOURCE: 'local',
        });

        for (const id of refIds) {
            assert.equal(fs.existsSync(join(instActive, id, 'SKILL.md')), true, `${id} should be active`);
        }
        assert.match(fs.readFileSync(join(instActive, 'search', 'SKILL.md'), 'utf8'), /from ref/);
        assert.equal(fs.existsSync(join(instActive, 'custom-local', 'SKILL.md')), true, 'custom active skill should survive');
        assert.equal(fs.existsSync(join(instActive, 'base-only', 'SKILL.md')), true, 'base fallback should activate local-only defaults');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('skill read falls back to skills_ref when active skill is missing', () => {
    const home = fs.mkdtempSync(join(os.tmpdir(), 'jaw-skill-read-home-'));
    try {
        const jawHome = join(home, '.cli-jaw-test');
        makeSkill(join(jawHome, 'skills_ref'), 'only-ref', 'only-ref-content\n');
        fs.mkdirSync(join(jawHome, 'skills'), { recursive: true });

        const output = execFileSync('npx', ['tsx', 'bin/commands/skill.ts', 'skill', 'read', 'only-ref'], {
            cwd: join(import.meta.dirname, '..', '..'),
            env: {
                ...process.env,
                CLI_JAW_HOME: jawHome,
                JAW_FORCE_CLONE: '1',
                JAW_SKILLS_SOURCE: 'local',
            },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        assert.match(output, /source: skills_ref fallback/);
        assert.match(output, /only-ref-content/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
