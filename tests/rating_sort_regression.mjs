import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const require=createRequire(new URL('../packages/panel/package.json',import.meta.url))
const {build}=require('esbuild')
const bundle=async name=>{
 const output=await build({entryPoints:[new URL('../packages/panel/src/lib/'+name+'.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false})
 return import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))
}
const {sortMedia,sortFileEntries,validRatingSort}=await bundle('rating-sort')
const {directoryVideos}=await bundle('playlist')
const make=(id,rating,extra={})=>({id,name:id,kind:'source',hasFile:true,storageId:'win',filePath:'parent/'+id+'.mp4',rating,...extra})
const videos=[make('low',2.5),make('unrated',0),make('high',9.5),make('middle',7),make('equal2',7),make('equal10',7),make('missing',undefined),make('invalid',NaN)]
const original=videos.map(x=>x.id)
assert.deepEqual(sortMedia(videos,'default').map(x=>x.id),original)
assert.deepEqual(sortMedia(videos,'rating-desc').map(x=>x.id),['high','equal2','equal10','middle','low','invalid','missing','unrated'])
assert.deepEqual(sortMedia(videos,'rating-asc').map(x=>x.id),['low','equal2','equal10','middle','high','invalid','missing','unrated'])
assert.deepEqual(videos.map(x=>x.id),original)
assert.deepEqual(sortMedia([],'rating-asc'),[])
for(const order of ['rating-desc','rating-asc']){
 assert.equal(validRatingSort(order),order)
 const fixtures=[...videos,make('child',10,{filePath:'parent/sub/child.mp4'}),make('other',10,{storageId:'other'}),make('clip',10,{kind:'clip'}),make('offline',10,{hasFile:false})]
 assert.deepEqual(directoryVideos(fixtures,videos[0],order).map(x=>x.id),sortMedia(videos,order).map(x=>x.id))
}
assert.equal(validRatingSort('bad'),'default')
assert.equal(validRatingSort(null),'default')
const entries=[{name:'low.mp4',path:'parent/low.mp4',kind:'file'},{name:'notes.txt',path:'parent/notes.txt',kind:'file'},{name:'high.mp4',path:'parent/high.mp4',kind:'file'},{name:'Folder',path:'parent/Folder',kind:'directory'},{name:'unrated.mp4',path:'parent/unrated.mp4',kind:'file'}]
const ratings=new Map(videos.map(v=>[v.filePath,v.rating]))
for(const [order,expected] of [['rating-desc',['Folder','high.mp4','low.mp4','notes.txt','unrated.mp4']],['rating-asc',['Folder','low.mp4','high.mp4','notes.txt','unrated.mp4']]]){
 assert.deepEqual(sortFileEntries(entries,e=>ratings.get(e.path),order).map(e=>e.name),expected)
}
assert.deepEqual(sortFileEntries(entries,e=>ratings.get(e.path),'default'),entries)
// Filtering stays restricted to the current search results; ties never shuffle with input order.
assert.deepEqual(sortMedia(videos.filter(v=>v.id==='low'||v.id==='high'),'rating-desc').map(v=>v.id),['high','low'])
assert.deepEqual(sortMedia([...videos].reverse(),'rating-desc').map(v=>v.id),sortMedia(videos,'rating-desc').map(v=>v.id))
console.log('Rating sort passed: numeric/fractional scores, both directions, unrated-last, folders-first, stable ties, default order, immutable inputs, search subset and matching same-directory playback')
