import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

test('both IndexedDB writers retain the trace link and scoped readers return it',async()=>{
    const rows:Record<string,unknown>[]=[];const storage=new Map<string,string>();
    const names=['indexedDB','IDBKeyRange','localStorage'] as const;
    const descriptors=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
    function request<T>(result:T) {
        const value={result,onsuccess:null as (()=>void)|null,onerror:null as (()=>void)|null};
        queueMicrotask(()=>value.onsuccess?.());return value;
    }
    const database={transaction(){
        const tx={oncomplete:null as (()=>void)|null,onerror:null as (()=>void)|null,objectStore(){return {
            indexNames:{contains:(name:string)=>name==='scope'},
            add(row:Record<string,unknown>){rows.push(structuredClone(row));queueMicrotask(()=>tx.oncomplete?.());},
            index(){return {openCursor(scope:unknown){
                const matches=rows.filter(row=>row['scope']===scope);let offset=0;
                const req={result:null as unknown,onsuccess:null as (()=>void)|null,onerror:null as (()=>void)|null};
                const advance=()=>queueMicrotask(()=>{
                    const row=matches[offset];
                    req.result=row?{value:structuredClone(row),
                        update(value:Record<string,unknown>){const replacement=structuredClone(value);rows[rows.indexOf(row)]=replacement;matches[offset]=replacement;},
                        delete(){rows.splice(rows.indexOf(row),1);},
                        continue(){offset++;advance();}}:null;
                    req.onsuccess?.();if(!row)queueMicrotask(()=>tx.oncomplete?.());
                });advance();return req;
            },getAll(scope:unknown){return request(rows.filter(row=>row['scope']===scope).map(row=>structuredClone(row)));}}},
        };}};
        return tx;
    }};
    Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open(){return request(database);}}});
    Object.defineProperty(globalThis,'IDBKeyRange',{configurable:true,value:{only:(value:unknown)=>value}});
    Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)}});
    try {
        const cache=await import('../../public/js/features/idb-cache.ts');
        cache.setMessageScope('first');
        await cache.cacheMessages([{message_id:7,role:'assistant',content:'saved',timestamp:1,trace_run_id:'tr_first'}]);
        cache.setMessageScope('second');
        const writing=cache.upsertMessage({message_id:9,role:'assistant',content:'live',timestamp:2,trace_run_id:'tr_second'});
        cache.setMessageScope('third');
        await writing;
        const first=await cache.getScopedMessages('first');const second=await cache.getScopedMessages('second');
        assert.equal(first[0]?.trace_run_id,'tr_first');assert.equal(first[0]?.message_id,7);
        assert.equal(second[0]?.trace_run_id,'tr_second');assert.equal(second[0]?.message_id,9);
        assert.equal(rows.length,2);
        await cache.upsertMessage({message_id:10,role:'user',content:'user text',timestamp:3,trace_run_id:'tr_second',scope:'second'});
        await cache.upsertMessage({message_id:11,role:'assistant',content:'foreign text',timestamp:4,trace_run_id:'tr_second',scope:'third'});
        const correcting=cache.replaceCachedAnswer('tr_second','original compatibility text','second');
        cache.setMessageScope('fourth');await correcting;
        const corrected=await cache.getScopedMessages('second');
        assert.equal(corrected[0]?.content,'original compatibility text');assert.equal(corrected[0]?.message_id,9);
        assert.equal(corrected[1]?.content,'user text');
        assert.equal((await cache.getScopedMessages('third'))[0]?.content,'foreign text');
        await cache.replaceCachedAnswer('missing','must not insert','second');assert.equal(rows.length,4);
        await cache.replaceCachedAnswer('tr_second','','second');
        assert.equal((await cache.getScopedMessages('second'))[0]?.content,'');assert.equal(rows.length,4);
    } finally {
        for(const name of names){const original=descriptors.get(name);if(original)Object.defineProperty(globalThis,name,original);else Reflect.deleteProperty(globalThis,name);}
    }
});

test('message DTO normalization and HTML preserve explicit session and saved identity only', async () => {
    setupWebUiDom();
    // Prevent any API prefetch or full history/UI startup; keep the real serializer,
    // sanitizer, message actions and HTML builder under test.
    const apiMock = mock.module('../../public/js/api.js', { namedExports: {
        API_BASE: '', api: async () => { throw new Error('No API calls in DTO tests'); },
        apiJson: async () => { throw new Error('No API calls in DTO tests'); },
        getAuthToken: async () => '',
    } });
    const chatMock = mock.module('../../public/js/features/chat-messages.js', { namedExports: {
        formatUserPrompt: (text: string) => text,
    } });
    try {
        const { normalizeMessageToolLog } = await import('../../public/js/features/process-log-adapter.ts');
        const { buildLazyVirtualMessageItem } = await import('../../public/js/features/message-item-html.ts');
        const session = 'chat-"<script>&\'';
        const message = normalizeMessageToolLog({ id: 'browser-local', server_message_id: 71,
            session_id: session, trace_run_id: 'tr_owned', role: 'assistant', content: 'EXACT saved answer',
            tool_log: '[{"label":"tool","detail":"recorded"}]' });
        assert.equal(message.session_id, session);
        assert.equal(message.server_message_id, 71);
        const item = buildLazyVirtualMessageItem(message, 4);
        assert.equal(item.messageId, 'browser-local');
        assert.ok(item.html.includes('data-message-session-id="chat-&quot;&lt;script&gt;&amp;&#39;"'));
        const host = document.createElement('div');
        host.innerHTML = item.html;
        const agent = host.querySelector<HTMLElement>('.msg-agent')!;
        assert.equal(agent.dataset['messageSessionId'], session);
        assert.equal(agent.dataset['serverMessageId'], '71');
        assert.equal(agent.dataset['activitySaved'], 'true');
        assert.equal(agent.dataset['messageId'], 'browser-local');
        assert.equal(agent.dataset['traceRunId'], 'tr_owned');
        assert.equal(host.querySelector('script'), null);
        assert.equal(host.querySelector('.agent-body')?.hasAttribute('data-trace-run-id'), false);

        for (const id of [undefined, 99, 'local-uuid']) {
            const legacy = normalizeMessageToolLog({ ...(id === undefined ? {} : { id }),
                role: 'assistant', content: 'legacy cache', trace_run_id: 'tr_legacy' });
            const legacyItem = buildLazyVirtualMessageItem(legacy, 0);
            host.innerHTML = legacyItem.html;
            const row = host.querySelector<HTMLElement>('.msg-agent')!;
            assert.equal(row.hasAttribute('data-message-session-id'), false);
            assert.equal(row.hasAttribute('data-server-message-id'), false);
            assert.equal(row.hasAttribute('data-activity-saved'), false, 'browser/IDB IDs are not saved DB proof');
            assert.equal(row.dataset['messageId'], legacyItem.messageId);
        }
        host.innerHTML = buildLazyVirtualMessageItem({ role: 'assistant', content: '', session_id: session }, 0).html;
        assert.equal(host.querySelector('.msg-agent')?.hasAttribute('data-activity-saved'), false);
        host.innerHTML = buildLazyVirtualMessageItem({ role: 'assistant', content: '', server_message_id: 72 }, 0).html;
        assert.equal(host.querySelector('.msg-agent')?.getAttribute('data-activity-saved'), 'true');
        assert.equal(host.querySelector('.msg-agent')?.hasAttribute('data-message-session-id'), false);
    } finally {
        chatMock.restore(); apiMock.restore(); resetWebUiDom();
    }
});
