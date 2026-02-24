// ─── Command Contract: Capability Catalog ────────────
// Phase 9.5 — COMMANDS 배열을 capability map으로 확장

import { COMMANDS } from '../cli/commands.ts';

export const CAPABILITY = {
    full: 'full',         // 실행 가능
    readonly: 'readonly', // 조회만 가능
    hidden: 'hidden',     // 목록에서 숨김
    blocked: 'blocked',   // 실행 차단
};

// Telegram 전용 readonly 대상
const TG_READONLY = new Set(['model', 'cli']);
// root CLI는 서브커맨드 체계
const CMDLINE_HIDDEN = new Set(['help', 'clear', 'model', 'cli', 'fallback',
    'status', 'reset', 'skill', 'employee', 'mcp', 'memory', 'browser', 'prompt', 'version']);

/**
 * COMMANDS 배열에 인터페이스별 capability map 추가
 * @returns {Array} 확장된 커맨드 배열
 */
export function getCommandCatalog() {
    return COMMANDS.map(cmd => ({
        ...cmd,
        capability: cmd.capability || {
            cli: cmd.interfaces.includes('cli')
                ? CAPABILITY.full
                : CAPABILITY.hidden,
            web: cmd.interfaces.includes('web')
                ? (cmd.hidden ? CAPABILITY.hidden : CAPABILITY.full)
                : CAPABILITY.hidden,
            telegram: cmd.interfaces.includes('telegram')
                ? (TG_READONLY.has(cmd.name) ? CAPABILITY.readonly : CAPABILITY.full)
                : CAPABILITY.hidden,
            cmdline: CMDLINE_HIDDEN.has(cmd.name) ? CAPABILITY.hidden : CAPABILITY.full,
        },
    }));
}
