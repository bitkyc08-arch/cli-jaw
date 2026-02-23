// ─── Orchestration (Plan → Distribute → Evaluate) ────

import { broadcast } from './bus.js';
import { insertMessage, getEmployees } from './db.js';
import { getSystemPrompt, getSubAgentPrompt } from './prompt.js';
import { spawnAgent } from './agent.js';

const MAX_ROUNDS = 3;

export function parseSubtasks(text) {
    if (!text) return null;
    const fenced = text.match(/```json\n([\s\S]*?)\n```/);
    if (fenced) {
        try { return JSON.parse(fenced[1]).subtasks || null; } catch { }
    }
    const raw = text.match(/(\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*\]\s*\})/);
    if (raw) {
        try { return JSON.parse(raw[1]).subtasks || null; } catch { }
    }
    return null;
}

export function stripSubtaskJSON(text) {
    return text
        .replace(/```json\n[\s\S]*?\n```/g, '')
        .replace(/\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*?\]\s*\}/g, '')
        .trim();
}

async function distributeAndWait(subtasks) {
    const emps = getEmployees.all();
    const results = [];

    const promises = subtasks.map(st => {
        const target = (st.agent || '').trim();
        const emp = emps.find(e =>
            e.name === target || e.name?.includes(target) || target.includes(e.name)
        );
        console.log(`[distribute] matching "${target}" → ${emp ? emp.name : 'NOT FOUND'}`);

        if (!emp) {
            results.push({ name: target, status: 'skipped', text: 'Agent not found' });
            return Promise.resolve();
        }

        const sysPrompt = getSubAgentPrompt(emp);
        broadcast('agent_status', { agentId: emp.id, agentName: emp.name, status: 'running', cli: emp.cli });

        const { promise } = spawnAgent(`## 작업 지시\n${st.task}`, {
            agentId: emp.id, cli: emp.cli, model: emp.model,
            forceNew: true, sysPrompt,
        });

        return promise.then(r => {
            results.push({ name: emp.name, id: emp.id, status: r.code === 0 ? 'done' : 'error', text: r.text || '' });
            broadcast('agent_status', { agentId: emp.id, agentName: emp.name, status: r.code === 0 ? 'done' : 'error' });
        });
    });

    await Promise.all(promises);
    return results;
}

export async function orchestrate(prompt) {
    const employees = getEmployees.all();

    if (employees.length === 0) {
        const { promise } = spawnAgent(prompt);
        const result = await promise;
        const stripped = stripSubtaskJSON(result.text);
        broadcast('orchestrate_done', { text: stripped || result.text || '' });
        return;
    }

    const planOpts = { agentId: 'planning' };

    broadcast('agent_status', { agentId: 'planning', agentName: '🎯 기획', status: 'running' });
    const { promise: p1 } = spawnAgent(prompt, planOpts);
    const r1 = await p1;

    let subtasks = parseSubtasks(r1.text);
    if (!subtasks?.length) {
        const stripped = stripSubtaskJSON(r1.text);
        broadcast('orchestrate_done', { text: stripped || r1.text || '' });
        return;
    }

    let round = 1;
    let lastResults = [];
    while (round <= MAX_ROUNDS) {
        console.log(`[orchestrate] round ${round}, ${subtasks.length} subtasks`);
        broadcast('round_start', { round, subtasks });

        const results = await distributeAndWait(subtasks);
        lastResults = results;

        const report = results.map(r =>
            `- ${r.name}: ${r.status === 'done' ? '✅ 완료' : '❌ 실패'}\n  응답: ${r.text.slice(0, 300)}`
        ).join('\n');
        const reportPrompt = `## 결과 보고 (라운드 ${round})\n${report}\n\n## 평가 기준\n- sub-agent가 응답을 보고했으면 → 완료로 판정\n- 단순 질문/인사 작업은 응답 자체가 성공적 결과입니다\n- 코드 작업은 실행 결과가 있으면 완료\n\n## 판정\n- **완료**: 사용자에게 보여줄 자연어 요약을 작성하세요. JSON 출력 절대 금지.\n- **미완료**: 구체적 사유를 밝히고 JSON subtasks를 다시 출력하세요.`;

        broadcast('agent_status', { agentId: 'planning', agentName: '🎯 기획', status: 'evaluating' });
        const { promise: evalP } = spawnAgent(reportPrompt, { ...planOpts, internal: true });
        const evalR = await evalP;

        subtasks = parseSubtasks(evalR.text);
        if (!subtasks?.length) {
            const stripped = stripSubtaskJSON(evalR.text);
            if (stripped) {
                insertMessage.run('assistant', stripped, 'orchestrator', '');
                broadcast('agent_done', { text: stripped });
            }
            broadcast('round_done', { round, action: 'complete' });
            broadcast('agent_status', { agentId: 'planning', status: 'idle' });
            broadcast('orchestrate_done', { text: stripped || '' });
            break;
        }
        broadcast('round_done', { round, action: 'retry' });
        round++;
    }

    if (round > MAX_ROUNDS) {
        const fallback = '⚠️ 최대 라운드(' + MAX_ROUNDS + ')에 도달했습니다.\n\n' +
            lastResults.map(r => `**${r.name}**: ${r.text.slice(0, 300)}`).join('\n\n');
        insertMessage.run('assistant', fallback, 'orchestrator', '');
        broadcast('agent_done', { text: fallback });
        broadcast('agent_status', { agentId: 'planning', status: 'idle' });
        broadcast('orchestrate_done', { text: fallback });
    }
}
