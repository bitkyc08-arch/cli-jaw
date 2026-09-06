import test,{mock} from 'node:test';
import assert from 'node:assert/strict';

let token:()=>Promise<string>=async()=> 'fixture-token';
mock.module('../../public/js/api.js',{namedExports:{API_BASE:'/i/41823',getAuthToken:()=>token()}});
const {requestBoundedJson,BoundedApiError}=await import('../../public/js/bounded-api.js');
test.after(()=>mock.restoreAll());

test('bounded writes retain proxy, method, body and existing auth',async t=>{
    let observed: {url:string;init?:RequestInit}|undefined;
    t.mock.method(globalThis,'fetch',async(input:unknown,init?:RequestInit)=>{
        observed={url:String(input),...(init?{init}:{})};
        return new Response('{"ok":true,"data":{"accepted":true}}',{headers:{'content-type':'application/json'}});
    });
    const body='{"response":{"optionId":"o0"}}';
    const value=await requestBoundedJson('/api/runtime/requests/r',{method:'POST',headers:{'Content-Type':'application/json'},body},new AbortController().signal,1024);
    assert.deepEqual(value,{ok:true,data:{accepted:true}});
    assert.equal(observed?.url,'/i/41823/api/runtime/requests/r');
    assert.equal(observed?.init?.body,body);assert.equal(observed?.init?.method,'POST');
    assert.equal(new Headers(observed?.init?.headers).get('Authorization'),'Bearer fixture-token');
});

test('UTF-8 receive overflow cancels an unclosed body before JSON decoding',async t=>{
    let cancelled=false;
    t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({
        start(controller){controller.enqueue(new TextEncoder().encode('"한글한글"'));},
        cancel(){cancelled=true;},
    }),{headers:{'content-type':'application/json'}}));
    await assert.rejects(requestBoundedJson('/api/runtime/requests',{},new AbortController().signal,8),/response_size_limit/);
    assert.equal(cancelled,true);
});

test('HTTP failure preserves status and never treats an error payload as a success',async t=>{
    t.mock.method(globalThis,'fetch',async()=>new Response('{"accepted":true}',{status:409,headers:{'content-type':'application/json'}}));
    await assert.rejects(requestBoundedJson('/api/runtime/requests/r',{},new AbortController().signal,1024),error=>error instanceof BoundedApiError&&error.status===409);
});

test('cancellation rejects even if token resolution never finishes',{timeout:1000},async t=>{
    const ready=Promise.withResolvers<string>();token=()=>ready.promise;
    let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('{}');});
    const controller=new AbortController();
    const pending=requestBoundedJson('/api/runtime/requests/r',{method:'POST',body:'{}'},controller.signal,1024);
    controller.abort();
    await assert.rejects(pending,{name:'AbortError'});assert.equal(calls,0);
    token=async()=> 'fixture-token';
});

test('cancellation interrupts pending fetch and pending response body without retrying the write', async t => {
    for (const stage of ['fetch', 'body']) {
        let calls = 0, cancelled = false;
        const entered = Promise.withResolvers<void>();
        t.mock.method(globalThis, 'fetch', async () => {
            calls++; entered.resolve();
            if (stage === 'fetch') return new Promise<Response>(() => {});
            return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
                headers: { 'content-type': 'application/json' },
            });
        });
        const controller = new AbortController();
        const task = requestBoundedJson('/api/runtime/requests/r', { method: 'POST' }, controller.signal, 1024);
        await entered.promise;
        // Let the real JSON reader acquire the stream before cancellation.
        if (stage === 'body') await new Promise<void>(resolve => setImmediate(resolve));
        controller.abort(); await assert.rejects(task, { name: 'AbortError' });
        assert.equal(calls, 1); if (stage === 'body') assert.equal(cancelled, true);
    }
});

test('15-second deadline is applied before network work and non-JSON response is rejected', async t => {
    const timeout = t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new DOMException('Timed out', 'TimeoutError')));
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('<html>'); });
    await assert.rejects(requestBoundedJson('/api/runtime/requests', {}, new AbortController().signal, 1024), { name: 'TimeoutError' });
    assert.equal(timeout.mock.calls[0]!.arguments[0], 15_000); assert.equal(calls, 0);
    timeout.mock.restore();
    await assert.rejects(requestBoundedJson('/api/runtime/requests', {}, new AbortController().signal, 1024),
        error => error instanceof BoundedApiError && error.status === 0);
});
