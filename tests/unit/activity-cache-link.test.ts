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
            index(){return {openCursor(){return request(null);},getAll(scope:unknown){return request(rows.filter(row=>row['scope']===scope).map(row=>structuredClone(row)));}}},
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
        await cache.upsertMessage({message_id:9,role:'assistant',content:'live',timestamp:2,trace_run_id:'tr_second'});
        const first=await cache.getScopedMessages('first');const second=await cache.getScopedMessages('second');
        assert.equal(first[0]?.trace_run_id,'tr_first');assert.equal(first[0]?.message_id,7);
        assert.equal(second[0]?.trace_run_id,'tr_second');assert.equal(second[0]?.message_id,9);
        assert.equal(rows.length,2);
    } finally {
        for(const name of names){const original=descriptors.get(name);if(original)Object.defineProperty(globalThis,name,original);else Reflect.deleteProperty(globalThis,name);}
    }
});
