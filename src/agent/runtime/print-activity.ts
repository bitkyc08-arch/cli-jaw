import type { RuntimeEventContext } from './events.js';
import { markActivityFailure } from '../../trace/activity-journal.js';
import { RuntimeProjection } from './projection.js';
import { createPrintActivityProjection, type PrintActivityProjection } from './print-projection.js';

/** Reuses canonical redaction, preview bounds and the existing per-run gap latch. */
export function createPrintActivity(context: RuntimeEventContext, provider: string): PrintActivityProjection {
    const projection: RuntimeProjection = new RuntimeProjection(context, undefined, reason => {
        if (reason === 'capacity' || reason === 'truncated') {
            markActivityFailure(context, 'run_limit');
            projection.report('persistence');
        }
    });
    projection.start(provider);
    return createPrintActivityProjection(body => {
        switch (body.kind) {
            case 'message': projection.text('message', body.itemId, body.text, body.operation, body.phase); break;
            case 'reasoning': projection.text('reasoning', body.itemId, body.text, body.operation); break;
            case 'tool': projection.tool(body.itemId, { name: body.name, status: body.status,
                ...(body.detail === undefined ? {} : { detail: body.detail }) }); break;
            case 'turn-end': projection.close(body); break;
        }
    });
}
