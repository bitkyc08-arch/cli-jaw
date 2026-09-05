import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {setupWebUiDom,resetWebUiDom} from './web-ui-test-dom.ts';

let visible=[2,3];
let change:()=>void=()=>{};
// The virtualizer owns geometry; this test controls its public measurement callback
// to exercise our real DOM adapter after a window moves backwards.
class Geometry {
    options:Record<string,unknown>;
    constructor(options:Record<string,unknown>){this.options=options;change=options['onChange'] as ()=>void;}
    _didMount(){return ()=>{};}
    _willUpdate(){}
    getVirtualItems(){return visible.map(index=>({index,start:index*100,size:100,end:(index+1)*100,key:index}));}
    getTotalSize(){return 400;}
    setOptions(options:Record<string,unknown>){this.options=options;}
    measureElement(){}
    measure(){}
    scrollToIndex(){}
    scrollToOffset(){}
}
mock.module('@tanstack/virtual-core',{namedExports:{Virtualizer:Geometry,elementScroll(){},observeElementRect(){},observeElementOffset(){}}});
mock.module('../../public/js/render.js',{namedExports:{releaseMermaidNodes(){}}});
mock.module('../../public/js/features/process-block.js',{namedExports:{releaseProcessBlockDetails(){}}});

test('recycled virtual rows keep DOM reading order and retain focus on a mounted control',async()=>{
    setupWebUiDom();
    const {VirtualScroll}=await import('../../public/js/virtual-scroll.ts');
    const view=new VirtualScroll('chatMessages');
    try{
        view.setItems(Array.from({length:4},(_,i)=>({id:String(i),html:`<div class="msg"><button id="row-${i}">Message ${i}</button></div>`,height:100})),{autoActivate:false});
        view.activateIfNeeded(false);
        const button=document.getElementById('row-2')!;button.focus();
        visible=[0,1,2,3];change();
        assert.deepEqual([...document.querySelectorAll('.vs-inner > [data-vs-idx]')].map(node=>Number((node as HTMLElement).dataset['vsIdx'])),[0,1,2,3]);
        assert.equal(document.activeElement,button);
        visible=[1,2,3];change();
        assert.deepEqual([...document.querySelectorAll('.vs-inner > [data-vs-idx]')].map(node=>Number((node as HTMLElement).dataset['vsIdx'])),[1,2,3]);
        assert.equal(document.activeElement,button);
    }finally{view.clear();resetWebUiDom();mock.restoreAll();}
});
