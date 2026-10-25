import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,dispatchMcp,TOOLS} from '../src/mcp-server.mjs';
const fake={status:()=>({server:'mock',profile_attested:false}),tabs:async()=>[],bind:async()=>({sessionId:'a'}),observe:async()=>({revision:'c'}),act:async()=>({status:'APPLIED_READBACK'}),fillFields:async()=>({status:'FIELD_VALUES_VERIFIED_UNSAVED'}),release:()=>({released:true})};
const token='test-secret-'.repeat(4);
test('initialize and tool definitions expose frontend-directed controls',async()=>{
 const a=await dispatchMcp({jsonrpc:'2.0',id:1,method:'initialize'},fake);
 assert.equal(a.result.serverInfo.name,'liming-browser-direct');
 const b=await dispatchMcp({jsonrpc:'2.0',id:2,method:'tools/list'},fake);
 assert.ok(b.result.tools.some(x=>x.name==='browser_act'));
 assert.ok(TOOLS.some(x=>x.name==='browser_observe'));
});
test('notification yields no reply',async()=>assert.equal(await dispatchMcp({jsonrpc:'2.0',method:'notifications/initialized'},fake),null));
test('HTTP server refuses unauthenticated requests and foreign Origins',async()=>{
 const api=createServer({token,controller:fake,port:0});const addr=await api.listen();
 try{
  const url=`http://127.0.0.1:${addr.port}/mcp`,data={jsonrpc:'2.0',id:1,method:'tools/list'};
  const unauthorized=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  assert.equal(unauthorized.status,401);
  const foreign=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,Origin:'https://evil.example'},body:JSON.stringify(data)});
  assert.equal(foreign.status,403);
  const ok=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(data)});
  assert.equal(ok.status,200);assert.ok((await ok.json()).result.tools.length>=17);
 }finally{await new Promise(r=>api.server.close(r));}
});
test('HTTP unrecognized methods cannot execute browser actions',async()=>{
 const a=await dispatchMcp({jsonrpc:'2.0',id:9,method:'arbitrary/execute'},fake);
 assert.equal(a.error.code,-32601);
});

test('readiness reports profile and durable ledger truth, not a static manual flag',async()=>{
 const ctl={...fake,status:async()=>({cdp_reachable:true,profile_attested:false,wal_durable:true,owner_attestation:{reason:'PROFILE_MISMATCH'}})};
 const api=createServer({token,controller:ctl,port:0});const a=await api.listen();
 try{
  const url=`http://127.0.0.1:${a.port}/readyz`;
  assert.equal((await fetch(url)).status,401);
  const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
  assert.equal(r.status,200);const json=await r.json();assert.equal(json.write_ready,false);assert.equal(json.profile_reason,'PROFILE_MISMATCH');
 }finally{await new Promise(r=>api.server.close(r));}
});
