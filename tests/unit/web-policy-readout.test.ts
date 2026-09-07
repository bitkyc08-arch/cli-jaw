import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
const writes: Array<{path:string;method:string;body:unknown}> = [];
mock.module('../../public/js/provider-icons.js',{namedExports:{providerIcon(){return '';},providerLabel(value:string){return value;}}});
mock.module('../../public/js/api.js',{namedExports:{API_BASE:'',async api(){return null;},async apiJson(){return null;},
    async getAuthToken(){return '';},async apiFire(path:string,method:string,body:unknown){writes.push({path,method,body});}}});
let setPerm:typeof import('../../public/js/features/settings-core.ts')['setPerm'];
test.before(async()=>{setupWebUiDom();({setPerm}=await import('../../public/js/features/settings-core.ts'));});
test.beforeEach(()=>{
    writes.length=0;document.querySelector('.perm-toggle')?.remove();
    const page=new window.DOMParser().parseFromString(readFileSync(new URL('../../public/index.html',import.meta.url),'utf8'),'text/html');
    document.body.append(document.importNode(page.querySelector('.perm-toggle')!,true));
});
test.after(()=>{resetWebUiDom();mock.restoreAll();});
for(const [value,label] of [
    ['auto','Auto'],['safe','Safe'],[[],'Custom (0 entries)'],[['auto'],'Custom (1 entry)'],
    [[' read ',''],'Custom (2 entries)'],[null,'Not provided'],[undefined,'Not provided'],
    ['AUTO','Unrecognized'],['<img src=x onerror=alert(1)>','Unrecognized'],[{secret:'DO_NOT_SHOW'},'Unrecognized'],[['read',1],'Unrecognized'],
] as const)test(`Classic configured-policy readout ${label}: ${JSON.stringify(value)}`,()=>{
    const before=structuredClone(value);
    setPerm(value,false);
    assert.match(document.querySelector('.perm-toggle')!.textContent!,new RegExp('Configured policy: '+label.replace(/[()]/g,'\\$&')));
    assert.equal(document.querySelector('.perm-btn')!.classList.contains('perm-auto'),value==='auto');
    assert.deepEqual(value,before);assert.deepEqual(writes,[]);
    assert.equal(document.querySelector('.perm-toggle img'),null);
    assert.doesNotMatch(document.querySelector('.perm-toggle')!.textContent!,/DO_NOT_SHOW|onerror/);
});
test('Classic missing readout is a no-op and does not write',()=>{
    document.querySelector('.perm-toggle')!.remove();setPerm('safe',false);assert.deepEqual(writes,[]);
});
test('Classic explicit legacy save keeps literal-auto payload and does not optimistically change saved readout',()=>{
    setPerm('safe',false);const before=document.querySelector('.perm-toggle')!.textContent;
    setPerm('safe');assert.deepEqual(writes,[{path:'/api/settings',method:'PUT',body:{permissions:'auto'}}]);
    assert.equal(document.querySelector('.perm-toggle')!.textContent,before);
});

test('Classic iframe replacement preserves Agents policy owner', () => {
    const page = new window.DOMParser().parseFromString(readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8'), 'text/html');
    assert.equal(page.querySelectorAll('#tabSettings > iframe.settings-frame').length, 1);
    assert.ok(page.querySelector('#tabAgents .perm-toggle'));
    assert.equal(page.querySelector('#tabSettings .perm-toggle'), null);
});
