import test from 'node:test';
import assert from 'node:assert/strict';

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
