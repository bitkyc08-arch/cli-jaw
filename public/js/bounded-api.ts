import { API_BASE, getAuthToken } from './api.js';

export class BoundedApiError extends Error {
    constructor(readonly status: number) { super(`Request failed (${status})`); }
}

/** Explicit, cancellable JSON requests for bounded replay and decision surfaces. */
export async function requestBoundedJson(path: string, init: RequestInit, signal: AbortSignal, maxBytes: number): Promise<unknown> {
    const boundedSignal=AbortSignal.any([signal,AbortSignal.timeout(15_000)]);
    boundedSignal.throwIfAborted();
    let rejectAbort!: (reason:unknown)=>void;
    const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
    const onAbort=()=>rejectAbort(boundedSignal.reason);
    boundedSignal.addEventListener('abort',onAbort,{once:true});
    try {
        const token=await Promise.race([getAuthToken(boundedSignal),aborted]);
        boundedSignal.throwIfAborted();
        const headers=new Headers(init.headers);
        if (token) headers.set('Authorization','Bearer '+token);
        const response=await fetch(API_BASE+path,{
            ...init,headers,signal:boundedSignal,
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new BoundedApiError(response.status);
        }
        if (!response.headers.get('content-type')?.includes('json') || !response.body) {
            await response.body?.cancel();
            throw new BoundedApiError(0);
        }
        const reader=response.body.getReader();
        const parts:Uint8Array[]=[];let size=0;
        try {
            for (;;) {
                const next=await reader.read();if(next.done)break;
                size+=next.value.byteLength;
                if(size>maxBytes){await reader.cancel();throw new Error('response_size_limit');}
                parts.push(next.value);
            }
        } finally {reader.releaseLock();}
        boundedSignal.throwIfAborted();
        const data=new Uint8Array(size);let offset=0;
        for(const part of parts){data.set(part,offset);offset+=part.length;}
        return JSON.parse(new TextDecoder().decode(data)) as unknown;
    } finally {boundedSignal.removeEventListener('abort',onAbort);}
}
