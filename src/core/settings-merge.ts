// ─── Settings Merge Logic ────────────────────────────
// Phase 9.4 — server.js의 applySettingsPatch에서 추출한 deep merge 로직

/**
 * settings 객체에 patch를 deep merge
 * perCli와 activeOverrides는 CLI별로 개별 merge (기존 effort/model 보존)
 * @param {object} current - 현재 settings
 * @param {object} patch - 적용할 패치
 * @returns {object} 새 settings (current를 직접 변경하지 않음)
 */
export function mergeSettingsPatch(current, patch) {
    const result = { ...current };
    const remaining = { ...patch };

    // Deep merge perCli at per-CLI level
    if (remaining.perCli && typeof remaining.perCli === 'object') {
        result.perCli = result.perCli || {};
        for (const [cli, cfg] of Object.entries(remaining.perCli)) {
            result.perCli[cli] = { ...result.perCli[cli], ...cfg };
        }
        delete remaining.perCli;
    }

    // Deep merge activeOverrides at per-CLI level
    if (remaining.activeOverrides && typeof remaining.activeOverrides === 'object') {
        result.activeOverrides = result.activeOverrides || {};
        for (const [cli, cfg] of Object.entries(remaining.activeOverrides)) {
            result.activeOverrides[cli] = { ...result.activeOverrides[cli], ...cfg };
        }
        delete remaining.activeOverrides;
    }

    // Deep merge nested objects (heartbeat, telegram, memory)
    for (const key of ['heartbeat', 'telegram', 'memory']) {
        if (remaining[key] && typeof remaining[key] === 'object') {
            result[key] = { ...result[key], ...remaining[key] };
            delete remaining[key];
        }
    }

    // Top-level scalar fields
    Object.assign(result, remaining);

    return result;
}
