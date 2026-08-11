// ─── Slack Roster ────────────────────────────────────
// "Who is in this channel?" and "who is in this workspace?" — the second half of
// the question an agent could not answer before. conversations.members returns
// bare user ids, so the names come from the identity cache and a bounded
// users.list join rather than one users.info call per member.
// Design + rate-limit facts: devlog 260811_slack_sender_identity_roster/030.

import { slackApi, describeSlackError, type SlackFetch } from './api.js';
import { redactChannelSecrets } from '../messaging/redact.js';
import {
    getCachedSlackIdentities,
    pickSlackUserName,
    primeSlackIdentityCache,
    resolveSlackIdentities,
    type RawSlackUser,
    type SlackIdentity,
} from './identity.js';

export type SlackRosterMember = {
    id: string;
    name: string;
    isBot: boolean;
    realName?: string;
    displayName?: string;
    deleted?: true;
};

export type SlackRosterResult =
    | { ok: true; members: SlackRosterMember[]; hasMore: boolean; partial: boolean; teamName?: string }
    | { ok: false; error: string };

/** Slack recommends staying at or below 200 per page. */
const PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;
/** conversations.members is Tier 4, so a slightly deeper walk is affordable. */
const MAX_MEMBER_PAGES = 5;
/** users.list is only Tier 2 — walk it far more conservatively. */
const MAX_LIST_PAGES = 3;
const TOP_UP_LIMIT = 25;

type RosterOpts = {
    teamId: string;
    limit?: number;
    fetchImpl?: SlackFetch;
    signal?: AbortSignal;
};

function clampLimit(limit: number | undefined): number {
    const n = Number(limit) || PAGE_SIZE;
    return Math.min(Math.max(Math.floor(n), 1), MAX_PAGE_SIZE);
}

function memberFromIdentity(identity: SlackIdentity): SlackRosterMember {
    const member: SlackRosterMember = {
        id: identity.id,
        name: identity.name,
        isBot: identity.isBot,
    };
    if (identity.realName) member.realName = identity.realName;
    if (identity.displayName) member.displayName = identity.displayName;
    return member;
}

/**
 * Channel membership.
 *
 * Deliberately NOT one users.info per member: a 200-person channel would be 200
 * round trips. Order is cache -> bounded users.list join -> small users.info
 * top-up. What is guaranteed is a CEILING on calls (5 member pages + 3 list pages
 * + 25 top-ups), not a page count for a given channel size — member ids and
 * users.list ordering are unrelated, so a target can sit on a later page.
 */
export async function fetchSlackChannelMembers(
    token: string, channel: string, opts: RosterOpts,
): Promise<SlackRosterResult> {
    const perPage = clampLimit(opts.limit);
    const ids: string[] = [];
    let cursor = '';
    let hasMore = false;

    for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
        const result = await slackApi<{ members?: string[]; response_metadata?: { next_cursor?: string } }>(
            token, 'conversations.members',
            { channel, limit: perPage, ...(cursor ? { cursor } : {}) },
            { form: true, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) },
        );
        if (!result.ok) {
            return { ok: false, error: redactChannelSecrets(describeSlackError(result.error, result.data)) };
        }
        for (const id of result.data?.members ?? []) if (id) ids.push(id);
        cursor = result.data?.response_metadata?.next_cursor?.trim() || '';
        if (!cursor) break;
        if (page === MAX_MEMBER_PAGES - 1) hasMore = true;
    }

    const { members, partial } = await namesForIds(token, ids, opts);
    return { ok: true, members, hasMore, partial };
}

/** Resolve names for a list of ids: cache, then a bounded list join, then top-up. */
async function namesForIds(
    token: string, ids: readonly string[], opts: RosterOpts,
): Promise<{ members: SlackRosterMember[]; partial: boolean }> {
    const resolved = new Map<string, SlackIdentity>(getCachedSlackIdentities(opts.teamId, ids));
    let missing = ids.filter(id => !resolved.has(id));

    let cursor = '';
    for (let page = 0; page < MAX_LIST_PAGES && missing.length; page += 1) {
        const result = await slackApi<{ members?: RawSlackUser[]; response_metadata?: { next_cursor?: string } }>(
            token, 'users.list',
            // Always send a limit. Slack marks it optional, but omitting it makes
            // Slack attempt the whole directory and can 500 on a large team.
            { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
            { form: true, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) },
        );
        if (!result.ok) break; // A list failure is not fatal; top-up still runs.
        primeSlackIdentityCache(opts.teamId, result.data?.members ?? []);
        const found = getCachedSlackIdentities(opts.teamId, missing);
        for (const [id, identity] of found) resolved.set(id, identity);
        missing = missing.filter(id => !resolved.has(id));
        cursor = result.data?.response_metadata?.next_cursor?.trim() || '';
        if (!cursor) break;
    }

    let partial = false;
    if (missing.length) {
        const batch = await resolveSlackIdentities(
            token, missing.map(id => ({ userId: id })),
            {
                teamId: opts.teamId, topUpLimit: TOP_UP_LIMIT,
                ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
                ...(opts.signal ? { signal: opts.signal } : {}),
            },
        );
        partial = batch.partial;
        for (const [id, identity] of batch.identities) resolved.set(id, identity);
    }

    const members = ids.map(id => {
        const identity = resolved.get(id);
        // An unresolved member still appears, under its raw id. A roster that
        // silently omits people is worse than one that admits it does not know.
        return identity
            ? memberFromIdentity(identity)
            : { id, name: id, isBot: false };
    });
    return { members, partial };
}

/**
 * Workspace directory.
 *
 * users.list already returns full user objects, so no users.info re-read is
 * needed — and priming the identity cache from these pages means later inbound
 * resolution is a cache hit.
 */
export async function fetchSlackWorkspaceUsers(
    token: string,
    opts: RosterOpts & { includeBots?: boolean; includeDeleted?: boolean },
): Promise<SlackRosterResult> {
    const perPage = clampLimit(opts.limit);
    const members: SlackRosterMember[] = [];
    let cursor = '';
    let hasMore = false;

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result = await slackApi<{ members?: RawSlackUser[]; response_metadata?: { next_cursor?: string } }>(
            token, 'users.list',
            { limit: perPage, ...(cursor ? { cursor } : {}) },
            { form: true, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) },
        );
        if (!result.ok) {
            return { ok: false, error: redactChannelSecrets(describeSlackError(result.error, result.data)) };
        }
        const page_members = result.data?.members ?? [];
        primeSlackIdentityCache(opts.teamId, page_members);
        for (const user of page_members) {
            if (!user?.id) continue;
            // "Who is here" normally means people, so bots and deactivated
            // accounts are opt-in rather than default noise.
            if (user.deleted && !opts.includeDeleted) continue;
            if (user.is_bot && !opts.includeBots) continue;
            const member: SlackRosterMember = {
                id: user.id,
                name: pickSlackUserName(user, user.id),
                isBot: user.is_bot === true,
            };
            if (user.deleted) member.deleted = true;
            members.push(member);
        }
        cursor = result.data?.response_metadata?.next_cursor?.trim() || '';
        if (!cursor) break;
        if (page === MAX_LIST_PAGES - 1) hasMore = true;
    }

    const teamName = await fetchTeamName(token, opts);
    return { ok: true, members, hasMore, partial: false, ...(teamName ? { teamName } : {}) };
}

/** Workspace name. Optional: without team:read the roster still returns fine. */
async function fetchTeamName(token: string, opts: RosterOpts): Promise<string> {
    const result = await slackApi<{ team?: { name?: string } }>(
        token, 'team.info', {},
        { form: true, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) },
    );
    return result.ok ? (result.data?.team?.name || '') : '';
}

const FORMAT_CHAR_CAP = 6000;

/** Plain-text rendering for the agent prompt. Names keep their ids alongside. */
export function formatRosterForAgent(
    result: SlackRosterResult,
    opts: { channel?: string } = {},
): string {
    if (!result.ok) return result.error;
    const heading = opts.channel
        ? `#${opts.channel} 멤버 ${result.members.length}명`
        : `${result.teamName ? `${result.teamName} ` : ''}워크스페이스 사용자 ${result.members.length}명`;
    const lines = result.members.map(member => {
        const tags = [member.id];
        if (member.isBot) tags.push('봇');
        if (member.deleted) tags.push('비활성');
        return `- ${member.name} (${tags.join(', ')})`;
    });
    if (result.hasMore) lines.push('… (페이지 상한에 도달해 일부만 표시)');
    if (result.partial) lines.push('… (이름 해석 상한에 도달해 일부는 id 로 표시)');
    return redactChannelSecrets([heading, ...lines].join('\n')).slice(0, FORMAT_CHAR_CAP);
}
