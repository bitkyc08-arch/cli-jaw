/**
 * src/prompt/soul-bootstrap-prompt.ts
 *
 * Builds a one-shot prompt for LLM-driven soul.md personalization.
 * The active CLI agent receives this prompt and rewrites soul.md
 * based on available user context (system profile, legacy memory, KV data).
 */

export interface SoulBootstrapContext {
    systemProfile: string;
    currentSoul: string;
    profileContent: string;
    kvEntries: { key: string; value: string }[];
    lang: string;
}

export function buildSoulBootstrapPrompt(ctx: SoulBootstrapContext): string {
    const kvBlock = ctx.kvEntries.length
        ? ctx.kvEntries.map(m => `- ${m.key}: ${m.value}`).join('\n')
        : '(no entries)';

    return `[SYSTEM] You are performing a one-time soul.md optimization for this user's AI assistant identity.

## Current soul.md
\`\`\`markdown
${ctx.currentSoul}
\`\`\`

## System profile
${ctx.systemProfile}

## User profile (from memory)
${ctx.profileContent || '(empty)'}

## Key-value memory (${ctx.kvEntries.length} entries)
${kvBlock}

## Task
Rewrite the soul.md above to be **personalized** for this specific user.

Rules:
1. Keep the exact section structure: Core Values, Tone, Boundaries, Relationship, Defaults
2. Replace generic placeholders with observations from the context above
3. Each section: 2-5 concise bullet points
4. ${ctx.lang === 'ko' ? 'Write in Korean' : 'Write in English'}
5. After writing, call the soul update API: POST /api/jaw-memory/soul with JSON body:
   { "section": "<section name>", "action": "replace", "content": "<new content>", "confidence": "high", "reason": "soul-bootstrap" }
   — Call once per section (Core Values, Tone, Boundaries, Relationship, Defaults)
6. When done, reply: "${ctx.lang === 'ko' ? '✅ Soul 최적화 완료' : '✅ Soul optimization complete'}"

Do NOT add new sections. Do NOT remove existing ones. Be specific, not generic.`;
}
