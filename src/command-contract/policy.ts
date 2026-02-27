// ─── Command Contract: Policy ────────────────────────
// Phase 9.5 — 인터페이스별 커맨드 필터링

import { getCommandCatalog, CAPABILITY } from './catalog.js';

/**
 * 특정 인터페이스에서 보이는 커맨드 목록 (hidden/blocked 제외)
 * @param {string} iface - 'cli' | 'web' | 'telegram' | 'cmdline'
 * @returns {Array}
 */
export function getVisibleCommands(iface: string) {
    return getCommandCatalog()
        .filter(c => {
            const cap = c.capability?.[iface];
            return cap && cap !== CAPABILITY.hidden && cap !== CAPABILITY.blocked;
        });
}

/**
 * 특정 인터페이스에서 실행 가능한 커맨드 목록 (full capability만)
 * @param {string} iface
 * @returns {Array}
 */
export function getExecutableCommands(iface: string) {
    return getCommandCatalog()
        .filter(c => c.capability?.[iface] === CAPABILITY.full);
}

/**
 * Telegram setMyCommands용 메뉴 — bot 자체 처리 커맨드만 제외
 * start/id/settings: bot.command()로 직접 핸들링
 * help/model/cli: readonly여도 팝업에 표시 (사용자 편의)
 * @returns {Array}
 */
export function getTelegramMenuCommands() {
    const BOT_HANDLED = new Set(['start', 'id', 'settings']);
    return getVisibleCommands('telegram')
        .filter(c => !BOT_HANDLED.has(c.name));
}
