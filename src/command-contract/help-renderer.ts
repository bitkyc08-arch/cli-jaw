// ─── Command Contract: Help Renderer ─────────────────
// Phase 9.5 — 인터페이스별 통일 /help 렌더링

import { getVisibleCommands } from './policy.ts';

/**
 * 커맨드 도움말 렌더링
 * @param {object} opts
 * @param {'cli'|'web'|'telegram'|'cmdline'} opts.iface
 * @param {string} [opts.commandName] - 특정 커맨드 상세 보기
 * @param {'text'|'html'} [opts.format='text']
 * @returns {{ ok: boolean, text: string }}
 */
export function renderHelp({ iface, commandName, format = 'text' } = {}) {
    const cmds = getVisibleCommands(iface || 'cli');

    if (!commandName) {
        const lines = cmds.map(c => {
            const cap = c.capability?.[iface];
            const tag = cap === 'readonly' ? ' [조회전용]' : '';
            const desc = c.desc || '';
            return `  /${c.name}${c.args ? ' ' + c.args : ''}${tag} — ${desc}`;
        });
        return { ok: true, text: '사용 가능한 커맨드:\n' + lines.join('\n') };
    }

    const cmd = cmds.find(c =>
        c.name === commandName || (c.aliases || []).includes(commandName)
    );
    if (!cmd) return { ok: false, text: `unknown: ${commandName}` };

    return {
        ok: true,
        text: [
            `/${cmd.name}${cmd.args ? ' ' + cmd.args : ''} — ${cmd.desc || ''}`,
            cmd.aliases?.length ? `별칭: ${cmd.aliases.join(', ')}` : '',
            cmd.examples?.length ? `예시:\n${cmd.examples.map(e => '  ' + e).join('\n')}` : '',
            `지원: ${Object.entries(cmd.capability || {})
                .filter(([, v]) => v !== 'hidden')
                .map(([k, v]) => `${k}(${v})`)
                .join(', ')}`,
        ].filter(Boolean).join('\n'),
    };
}
