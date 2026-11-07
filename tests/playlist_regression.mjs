import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const require = createRequire(new URL('../packages/panel/package.json', import.meta.url))
const {build} = require('esbuild')
const result = await build({entryPoints: [new URL('../packages/panel/src/lib/playlist.ts', import.meta.url).pathname], bundle: true, platform:'node', format:'esm', write:false})
const {directoryVideos, videoSwipe} = await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))
const current = {id:'a', kind:'source', hasFile:true, storageId:'win', filePath:'parent/A.mp4', name:'A'}
const sibling = {id:'b', kind:'source', hasFile:true, storageId:'win', filePath:'parent/B.mp4', name:'B'}
const fixtures = [sibling, current,
 {...sibling,id:'child',filePath:'parent/sub/B.mp4'},
 {...sibling,id:'other-root',storageId:'other'},
 {...sibling,id:'offline',hasFile:false},
 {...sibling,id:'clip',kind:'clip'},
 {...sibling,id:'outside',filePath:'elsewhere/B.mp4'}]
assert.deepEqual(directoryVideos(fixtures,current).map(i=>i.id),['a','b'])
assert.deepEqual(directoryVideos([current,{...sibling,filePath:'parent\\B.mp4'}],current).map(i=>i.id),['a','b'])
assert.deepEqual(directoryVideos(fixtures,undefined),[])
assert.deepEqual(directoryVideos(fixtures,{...current,kind:'clip'}),[])
assert.equal(videoSwipe(5,-100),-1)
assert.equal(videoSwipe(5,100),1)
assert.equal(videoSwipe(0,40),0)
assert.equal(videoSwipe(120,100),0)
assert.equal(videoSwipe(100,10),0)
console.log('Playlist scope, directory ordering, Windows separators and swipe directions passed (9 checks)')
