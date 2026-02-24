// ─── Command Contract: Policy ────────────────────────
// Phase 9.5 — 인터페이스별 커맨드 필터링

import { getCommandCatalog, CAPABILITY } from './catalog.ts';

/**
 * 특정 인터페이스에서 보이는 커맨드 목록 (hidden/blocked 제외)
 * @param {string} iface - 'cli' | 'web' | 'telegram' | 'cmdline'
 * @returns {Array}
 */
export function getVisibleCommands(iface) {
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
export function getExecutableCommands(iface) {
    return getCommandCatalog()
        .filter(c => c.capability?.[iface] === CAPABILITY.full);
}

/**
 * Telegram setMyCommands용 메뉴 — reserved 제외, full capability만
 * @returns {Array}
 */
export function getTelegramMenuCommands() {
    const RESERVED = new Set(['start', 'id', 'help', 'settings']);
    return getVisibleCommands('telegram')
        .filter(c => !RESERVED.has(c.name) && c.capability?.telegram === CAPABILITY.full);
}
