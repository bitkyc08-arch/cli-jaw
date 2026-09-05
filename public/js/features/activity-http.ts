import { BoundedApiError, requestBoundedJson } from '../bounded-api.js';

export class ActivityReadError extends Error {
    constructor(readonly status: number) {
        super(status === 404 ? 'Activity is unavailable for this conversation.'
            : 'Activity could not be loaded. Retry when the connection is available.');
    }
}

/** Unlike the general API helper, replay must preserve aborts and failed reads. */
export async function readActivityHttp(path: string, signal: AbortSignal): Promise<unknown> {
    try { return await requestBoundedJson(path,{},signal,270_000); }
    catch(error) { if(error instanceof BoundedApiError) throw new ActivityReadError(error.status); throw error; }
}
