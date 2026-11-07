import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const require = createRequire(new URL('../packages/panel/package.json', import.meta.url))
const {build} = require('esbuild')
const hooks=[],effects=[];let cursor=0
// Deterministic native-event replay, with a minimal hook host and DOM.
globalThis.__selectionHost={useRef(initial){const i=cursor++;return hooks[i]??={current:initial}},useEffect(fn,deps){const i=cursor++;if(!hooks[i]||deps.some((d,n)=>d!==hooks[i][n])){hooks[i]=deps;effects.push(fn)}}}
const result=await build({entryPoints:[new URL('../packages/panel/src/lib/useDragSelection.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'host',setup(b){b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const {useRef,useEffect}=globalThis.__selectionHost; export const useLayoutEffect=useEffect'}))}}]})
const {useDragSelection}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))
class Element extends EventTarget{
 constructor(id,handle=false){super();this.dataset={dragSelectId:id};this.handle=handle}
 closest(s){if(s==='[data-drag-select-id]')return this.dataset.dragSelectId?this:null;if(s==='[data-drag-select-handle]')return this.handle?this:null;return null}
 contains(row){return rows.includes(row)}
}
globalThis.Element=Element
const root=new Element(),rows=['a','b','c','d','e'].map(id=>new Element(id,true))
const document=globalThis.document=new EventTarget();document.elementFromPoint=(x,y)=>y>=100&&y<600?rows[Math.floor((y-100)/100)]:null
const window=globalThis.window=new EventTarget();window.innerHeight=844
let scroll=0;window.scrollBy=({top})=>{scroll+=top}
let timers=new Map(),frames=new Map(),seq=0
const realTimeout=globalThis.setTimeout,realClear=globalThis.clearTimeout
globalThis.setTimeout=fn=>{timers.set(++seq,fn);return seq};globalThis.clearTimeout=id=>timers.delete(id)
globalThis.requestAnimationFrame=fn=>{frames.set(++seq,fn);return seq};globalThis.cancelAnimationFrame=id=>frames.delete(id)
let selected=new Set(),selecting=false,scope='',disabled=false,api
const render=()=>{cursor=0;api=useDragSelection({root:{current:root},ids:rows.map(r=>r.dataset.dragSelectId),selected,selecting,scope,disabled,setSelected:fn=>{selected=fn(selected)},setSelecting:v=>{selecting=v}});effects.splice(0).forEach(fn=>fn())}
render()
const fire=(type,row,y,{x=20,touches=1,pointerType}={})=>{
 const e=new Event(type,{cancelable:true}),t={identifier:7,clientX:x,clientY:y}
 Object.defineProperties(e,{target:{value:row},touches:{value:Array.from({length:touches},()=>t)},changedTouches:{value:[t]},pointerId:{value:1},pointerType:{value:pointerType},isPrimary:{value:true},button:{value:0},clientX:{value:x},clientY:{value:y}})
 document.dispatchEvent(e);render();return e
}
const hold=()=>{const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());render()}
const end=()=>fire('touchend',rows[0],150,{touches:0})
fire('touchstart',rows[0],150);assert.equal(fire('touchmove',rows[1],250).defaultPrevented,false);hold();assert.equal(selecting,false);assert.equal(selected.size,0)
fire('touchstart',rows[0],150);hold();assert.equal(selecting,true);assert.deepEqual([...selected],['a']);assert.equal(api.active.current,true)
assert.equal(fire('touchmove',rows[3],450).defaultPrevented,true);assert.deepEqual([...selected],['a','b','c','d'])
fire('touchmove',rows[1],250);assert.equal(selected.size,4);end();assert.equal(api.active.current,false);assert.equal(frames.size,0)
fire('touchstart',rows[0],150);fire('touchmove',rows[2],350);end();assert.deepEqual([...selected],['d'])
fire('touchstart',rows[4],550);fire('touchmove',rows[4],800)
document.elementFromPoint=()=>rows[3]
const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn(100));assert.ok(scroll>0);assert.equal(selected.has('d'),true)
document.elementFromPoint=(x,y)=>y>=100&&y<600?rows[Math.floor((y-100)/100)]:null
fire('touchcancel',rows[4],800,{touches:0});assert.equal(frames.size,0)
fire('touchstart',rows[0],150);scope='different folder';render();assert.equal(api.active.current,false)
fire('touchstart',rows[1],250);disabled=true;render();assert.equal(frames.size,0);disabled=false;render()
fire('touchstart',rows[1],250);fire('touchstart',rows[2],350,{touches:2});assert.equal(api.active.current,false)
fire('touchstart',rows[1],250);window.dispatchEvent(new Event('blur'));assert.equal(frames.size,0)
let blocked=false;api.itemProps('a').onClickCapture({preventDefault(){blocked=true},stopPropagation(){}});assert.equal(blocked,true)
fire('touchstart',rows[0],150);fire('pointercancel',rows[0],150,{pointerType:'touch'});assert.equal(api.active.current,true);end()
fire('pointerdown',rows[1],250,{pointerType:'mouse'});fire('pointermove',rows[4],550,{pointerType:'mouse'});fire('pointerup',rows[4],550,{pointerType:'mouse'});assert.equal(api.active.current,false)
globalThis.setTimeout=realTimeout;globalThis.clearTimeout=realClear
console.log('Passed: hold-and-drag, select/deselect, skipped rows, auto-scroll, click suppression, navigation/modal/multitouch cancellation and pointer handling')
