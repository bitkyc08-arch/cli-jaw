// ─── Telegram Hub Types ──────────────────────────────
// Topic→instance routing model for the Dashboard-owned Telegram hub (P1).
// No imports → no circular dependency with src/manager/types.ts.

export type ThreadRoute = {
    chatId: string;     // forum supergroup id
    threadId: string;   // message_thread_id; '1' = General
    port: number;       // managed instance port (3457..3506)
    label?: string;
    enabled: boolean;
    // P4 optional per-topic overrides:
    systemPrompt?: string;
    model?: string;
};

export type TelegramHubConfig = {
    enabled: boolean;
    token: string;        // SECRET — redacted on read
    chatId: string;       // bound forum supergroup id
    defaultPort: number;  // fallback for unmapped topics
    routes: ThreadRoute[];
};
