// ─── Forwarder origin policy ─────────────────────────
// The per-channel `agent_done` forwarders exist for one job: a turn that began
// somewhere OTHER than this chat channel (the web UI, the CLI, an API caller)
// still deserves to have its answer land in the conversation the user is
// watching. The channel's own dispatch path handles its own turns, so each
// forwarder skips its own origin.
//
// Background producers are a third case that was never separated out, and it
// showed. A heartbeat job already owns a destination — an operator picked the
// channel and thread the report belongs in — and it delivers there itself. The
// forwarder then saw the same turn's `agent_done` and posted the text AGAIN,
// to whichever conversation happened to be last-active, which is not where the
// operator pointed the job. Two copies, one of them in the wrong room.
//
// Worse, the forwarder sees that text EARLIER than the heartbeat does.
// `agent_done` is broadcast when the agent exits; the heartbeat's own
// `[SILENT]` check, report parsing and policy filter all run after
// `orchestrate_done`. So a job that decided it had nothing to say, or whose
// output was meant to be suppressed by `reportPolicy`, had already leaked.

/** Origins whose output is delivered by their own producer, not by a channel
 *  forwarder. Keep this list small and specific: the forwarder failing open is
 *  what makes web/CLI turns visible at all. */
const PRODUCER_OWNED_ORIGINS = new Set(['heartbeat']);

/**
 * True when a channel forwarder must NOT post this `agent_done`.
 *
 * `ownChannel` is the transport asking — it skips its own turns because its
 * dispatch path is already standing there with the answer.
 */
export function shouldSkipForwarding(
    data: Record<string, unknown>,
    ownChannel: string,
): boolean {
    const origin = typeof data['origin'] === 'string' ? data['origin'] : '';
    if (origin === ownChannel) return true;
    return PRODUCER_OWNED_ORIGINS.has(origin);
}
