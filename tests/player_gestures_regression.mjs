import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const require=createRequire(new URL('../packages/panel/package.json',import.meta.url))
const {build}=require('esbuild')
const output=await build({entryPoints:[new URL('../packages/panel/src/lib/player-gestures.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'})
const {containedVideoBounds,holdDirection,boundedSeek,previewOffset,HoldSeek}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))
const box={left:0,top:100,width:400,height:300}
const portrait=containedVideoBounds(box,360,640)
assert.equal(portrait.height,300);assert.equal(portrait.width,168.75)
assert.equal(holdDirection(20,200,portrait),0,'letterbox must not seek')
assert.equal(holdDirection(130,200,portrait),-1)
assert.equal(holdDirection(270,200,portrait),1)
assert.equal(holdDirection(200,200,portrait),0)
assert.equal(holdDirection(130,80,portrait),0)
assert.equal(boundedSeek(-10,5,20),5)
assert.equal(boundedSeek(40,5,20),19.96)
assert.equal(previewOffset(100,800,true),100)
assert.equal(previewOffset(-100,800,false),-18)
assert.equal(previewOffset(1200,800,true),800)
const saved={setTimeout,clearTimeout,setInterval,clearInterval,performance}
let now=0,seq=0;const timers=new Map(),intervals=new Map()
globalThis.setTimeout=fn=>{timers.set(++seq,fn);return seq};globalThis.clearTimeout=id=>timers.delete(id)
globalThis.setInterval=fn=>{intervals.set(++seq,fn);return seq};globalThis.clearInterval=id=>intervals.delete(id)
Object.defineProperty(globalThis,'performance',{value:{now:()=>now},configurable:true})
let plays=0,pauses=0,shown=0,time=0
const video={currentTime:10,paused:false,pause(){this.paused=true;pauses++},async play(){this.paused=false;plays++}}
const hold=new HoldSeek()
const begin=direction=>hold.begin(direction,video,0,30,value=>{time=value},value=>{shown=value})
const activate=()=>{const work=[...timers.values()];timers.clear();work.forEach(fn=>fn())}
const tick=()=>{now+=120;[...intervals.values()].forEach(fn=>fn())}
begin(1);assert.equal(hold.stop(),false);activate();assert.equal(pauses,0,'short tap must not pause or scrub')
begin(1);activate();assert.equal(hold.active,true);assert.equal(shown,1);tick();tick();assert.ok(Math.abs(time-12.4)<0.001)
assert.equal(hold.stop(),true);assert.equal(video.paused,false);assert.equal(plays,1);assert.equal(shown,0);assert.equal(intervals.size,0)
video.paused=true;begin(-1);activate();tick();assert.ok(Math.abs(video.currentTime-11.2)<0.001);hold.stop();assert.equal(video.paused,true,'initially paused video stays paused')
video.currentTime=0.2;begin(-1);activate();tick();assert.equal(video.currentTime,0);hold.stop()
video.currentTime=29.8;video.paused=false;begin(1);activate();tick();assert.equal(video.currentTime,29.96);hold.stop(false);assert.equal(video.paused,true,'navigation/blur must not restart the old video')
assert.equal(timers.size,0);assert.equal(intervals.size,0)
Object.assign(globalThis,{setTimeout:saved.setTimeout,clearTimeout:saved.clearTimeout,setInterval:saved.setInterval,clearInterval:saved.clearInterval})
Object.defineProperty(globalThis,'performance',{value:saved.performance,configurable:true})
console.log('Player gestures passed: letterbox boundaries, left/right holds, tap cancellation, 10× seeking, playback restoration, clip limits and swipe preview bounds')
