import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const require=createRequire(new URL('../packages/panel/package.json',import.meta.url))
const {build}=require('esbuild')
const bundle=async name=>{
 const output=await build({entryPoints:[new URL('../packages/panel/src/lib/'+name+'.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false})
 return import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))
}
const {deleteBatch}=await bundle('batch-delete')
const sent=[],progress=[]
const partial=await deleteBatch(['a','b','a','c'],async id=>{sent.push(id);if(id==='b')throw new Error('文件被占用')},(done,total)=>progress.push([done,total]))
assert.deepEqual(sent,['a','b','c']);assert.deepEqual(partial.removed,['a','c']);assert.deepEqual(partial.failures,[{id:'b',message:'文件被占用'}])
assert.deepEqual(progress,[[0,3],[1,3],[2,3],[3,3]])
const retry=await deleteBatch(partial.failures.map(f=>f.id),async id=>{sent.push(id)})
assert.deepEqual(retry.removed,['b']);assert.equal(retry.failures.length,0);assert.deepEqual(sent,['a','b','c','b'])
const offlineCalls=[]
const offline=await deleteBatch(['one','two','three'],async id=>{offlineCalls.push(id);throw new TypeError('Failed to fetch')})
assert.deepEqual(offlineCalls,['one']);assert.equal(offline.removed.length,0);assert.deepEqual(offline.failures.map(f=>f.id),['one','two','three'])
const timeout=await deleteBatch(['one','two'],async()=>{throw Object.assign(new Error('timeout'),{name:'AbortError'})})
assert.equal(timeout.failures.length,2);assert.match(timeout.failures[0].message,/尚未确认/)
assert.deepEqual(await deleteBatch([],async()=>{assert.fail('empty selection must not call API')}),{removed:[],failures:[]})
// Exercise the real HTTP error shape used by the batch helper; no network calls.
const values=new Map([['vm.endpoint','http://test.invalid'],['vm.token','fixture-token']])
globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}
const {transport,RequestError}=await bundle('transport')
globalThis.fetch=async url=>({status:url.endsWith('/missing')?404:url.endsWith('/locked')?409:200,json:async()=>url.endsWith('/missing')?{ok:false,error:{message:'素材不存在'}}:url.endsWith('/locked')?{ok:false,error:{message:'文件被占用'}}:{ok:true,data:{removed:true}}})
await assert.rejects(transport.request('/locked'),error=>error instanceof RequestError&&error.status===409&&error.message==='文件被占用')
const http=await deleteBatch(['missing','locked','valid'],id=>transport.request('/'+id,{method:'DELETE'}))
assert.deepEqual(http.removed,['missing','valid']);assert.deepEqual(http.failures,[{id:'locked',message:'文件被占用'}])
console.log('Batch delete passed: fixed selection, deduplication, partial failures, retry scope, progress, disconnect/timeout handling, empty selection and idempotent HTTP 404')
