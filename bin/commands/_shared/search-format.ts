// Shared rendering for the search commands.
//
// Two shapes, deliberately kept apart. The dashboard commands search across instances, so
// they carry a hit count, an instance label and warnings; the local ones search one place
// and have none of those. Giving the local pair a header would mean inventing instances
// and warnings where neither exists, so what they share is one line of body text.

/** Body text ceiling. The two local commands used to disagree, at 200 and 300, for no reason. */
export const CHAT_BODY_LIMIT = 300;

export type FederatedWarning = { instanceId: string; code: string; message: string };

export type FederatedResult<Hit> = {
    hits: Hit[];
    instancesQueried: number;
    instancesSucceeded: number;
    warnings: FederatedWarning[];
};

/**
 * Renders a cross-instance result.
 *
 * The per-hit renderer is supplied by the caller: a memory hit points at a file and line
 * while a chat hit points at a moment in a conversation, and flattening the two would
 * serve neither.
 */
export function formatFederatedResult<Hit>(
    data: FederatedResult<Hit>,
    renderHit: (hit: Hit) => string[],
): string {
    const lines: string[] = [
        `# ${data.hits.length} hits across ${data.instancesSucceeded}/${data.instancesQueried} instances`,
    ];
    for (const hit of data.hits) lines.push(...renderHit(hit));
    if (data.warnings.length) {
        lines.push('\n--- warnings ---');
        for (const warning of data.warnings) {
            lines.push(`[${warning.instanceId}] ${warning.code}: ${warning.message}`);
        }
    }
    return lines.join('\n');
}

export type LocalChatHit = {
    created_at?: unknown;
    role?: unknown;
    content?: unknown;
};

/**
 * One line of a local chat hit.
 *
 * Callers wrap this differently — one adds a context block and a separator, the other a
 * heading and an indent — and those differences are theirs to keep.
 */
export function renderLocalChatHit(hit: LocalChatHit, limit = CHAT_BODY_LIMIT): string {
    const content = String(hit.content ?? '').slice(0, limit);
    return `[${String(hit.created_at ?? '')}] (${String(hit.role ?? '')}) ${content}`;
}
