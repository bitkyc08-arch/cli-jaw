// ─── Logger (level-aware console wrapper) ────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1;

export const log = {
    debug: (...args) => { if (current <= 0) console.debug('[debug]', ...args); },
    info: (...args) => { if (current <= 1) console.log(...args); },
    warn: (...args) => { if (current <= 2) console.warn(...args); },
    error: (...args) => { if (current <= 3) console.error(...args); },
};
