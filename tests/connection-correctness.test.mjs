import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
const start=source.indexOf('function tryPatchSendRequest()');
const code=source.slice(start,source.indexOf('\n}',start)+2);
const settle=async()=>{for(let i=0;i<10;i++) await new Promise(setImmediate);};
function setup(result){
 const records=[];const profile={id:'p',api:'custom',model:'profile-model'};
 const service={getProfile:()=>profile,sendRequest:async()=>result};
 const context=vm.createContext({usageRevision:0,TOKEN_USAGE_PATCHED:Symbol('test'),console,
  getContext:()=>({ConnectionManagerRequestService:service,CONNECT_API_MAP:{custom:{source:'custom'}}}),
  countInputTokens:async()=>10,countTokens:async text=>typeof text==='string'?text.split(/\s+/).filter(Boolean).length:0,
  getCurrentModelId:()=>{throw Error('Global model must not be used');},getCurrentSourceId:()=>{throw Error('Global source must not be used');},
  recordUsage:(...args)=>records.push(args),recordFailedAttempt:(...args)=>records.push(['failed',...args])});
 vm.runInContext(code,context);assert.equal(context.tryPatchSendRequest(),true);
 return {service,records,context};
}
test('profile calls use overridden request identity and count extracted reasoning',async()=>{
 const value={content:'one two',reasoning:'three four five'};const r=setup(value);
 assert.equal(await r.service.sendRequest('p',[],50,{}, {model:'override-model'}),value);await settle();
 assert.deepEqual(r.records[0],[10,2,null,'override-model','custom',3,'succeeded']);
});
test('stream factory stays uncounted until consumed, then counts alternatives and reasoning',async()=>{
 const chunk={text:'one',swipes:['two three'],state:{reasoning:'thought'}};
 const r=setup(async function*(){yield chunk;});const factory=await r.service.sendRequest('p',[],50,{stream:true});
 await settle();assert.equal(r.records.length,0);
 for await(const actual of factory()) assert.equal(actual,chunk);
 await settle();assert.deepEqual(r.records[0],[10,3,null,'profile-model','custom',1,'succeeded']);
});
test('raw choices are counted once and an intervening reset discards pending accounting',async()=>{
 const r=setup({choices:[{message:{content:'one'}},{message:{content:'two three'}}]});
 await r.service.sendRequest('p',[],50,{extractData:false});await settle();assert.equal(r.records[0][1],3);
 r.records.length=0;let release;r.context.countInputTokens=()=>new Promise(resolve=>{release=resolve;});
 await r.service.sendRequest('p',[],50,{});r.context.usageRevision++;release(10);await settle();assert.equal(r.records.length,0);
});
