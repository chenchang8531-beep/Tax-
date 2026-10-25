import test from 'node:test';
import assert from 'node:assert/strict';
import {createGateway} from '../gateway.mjs';
import {WindowsTunnelAgent} from '../agent.mjs';
import {createServer} from '../../runtime/src/mcp-server.mjs';
import {setTimeout as delay} from 'node:timers/promises';

const frontendToken='frontend-secret-'.repeat(3),agentToken='agent-secret-'.repeat(4),localToken='local-secret-'.repeat(4),agentId='win-xero-synthetic';
async function fixture({clientTimeoutMs=4000,controller=null,agentFetcher=fetch}={}){
 let writes=0;
 const ctl=controller||{status:async()=>({cdp_reachable:true,profile_attested:true,wal_durable:true}),tabs:async()=>[],bind:async()=>({sessionId:'synthetic'}),observe:async()=>({revision:'a'}),act:async()=>{writes++;return {status:'POSTSTATE_VERIFIED',poststate_verified:true};},fillFields:async()=>({status:'FIELD_VALUES_VERIFIED_UNSAVED'}),verifySaved:async()=>({status:'DRAFT_PERSISTENCE_VERIFIED'}),release:()=>({released:true})};
 const local=createServer({token:localToken,controller:ctl,port:0});const locAddr=await local.listen();
 const gateway=createGateway({frontendToken,agentToken,agentId,localTests:true,clientTimeoutMs,waitNextMs:500});const gwAddr=await gateway.listen(0);
 const gwUrl=`http://127.0.0.1:${gwAddr.port}`,localUrl=`http://127.0.0.1:${locAddr.port}/mcp`;
 const agent=new WindowsTunnelAgent({gatewayUrl:gwUrl,agentToken,agentId,localToken,localUrl,localTests:true,fetcher:agentFetcher});
 return {gateway,agent,gwUrl,getWrites:()=>writes,close:async()=>{await gateway.close();await new Promise(r=>local.server.close(r));}};
}
const rpc=(id,name,args={})=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
test('two-secret HTTPS architecture works end-to-end over outbound agent poll without exposing local CDP',async()=>{
 const f=await fixture();try{
  const pending=f.agent.step();await delay(30);
  const r=await fetch(`${f.gwUrl}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${frontendToken}`,'content-type':'application/json'},body:JSON.stringify(rpc(8,'browser_act'))});
  assert.equal(r.status,200);const payload=await r.json();assert.equal(payload.result.content[0].type,'text');assert.equal(JSON.parse(payload.result.content[0].text).poststate_verified,true);
  const ack=await pending;assert.equal(ack.reported,true);assert.equal(f.getWrites(),1);
  const stat=await fetch(`${f.gwUrl}/status`,{headers:{Authorization:`Bearer ${frontendToken}`}});assert.equal((await stat.json()).agent_online,true);
 }finally{await f.close();}
});
test('remote tunnel rejects unauthorized frontend/agent, never exposes direct Chrome/CDP',async()=>{
 const f=await fixture();try{
  assert.equal((await fetch(`${f.gwUrl}/status`)).status,401);
  assert.equal((await fetch(`${f.gwUrl}/agent/next`,{headers:{Authorization:`Bearer ${frontendToken}`,'X-Liming-Agent-Id':agentId}})).status,401);
  assert.equal((await fetch(`${f.gwUrl}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${frontendToken}`,'Content-Type':'application/json'},body:JSON.stringify(rpc(2,'browser_act'))})).status,503);
  assert.equal((await fetch(`${f.gwUrl}/json/list`)).status,404);
 }finally{await f.close();}
});
test('an uncertain local action is delivered once and is not automatically replayed',async()=>{
 let attempts=0;const controller={status:async()=>({}),tabs:async()=>[],bind:async()=>({}),observe:async()=>({}),act:async()=>{attempts++;throw Error('CDP disconnected after write');},fillFields:async()=>({}),verifySaved:async()=>({}),release:()=>({})};
 const f=await fixture({controller});try{
  const next=f.agent.step();await delay(30);
  const r=await fetch(`${f.gwUrl}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${frontendToken}`,'Content-Type':'application/json'},body:JSON.stringify(rpc(44,'browser_act',{}))});
  const result=await r.json();assert.equal(result.result.isError,true);assert.equal(attempts,1);await next;
 }finally{await f.close();}
});
test('HTTP gateway refuses non-HTTPS untrusted production request even with tokens',async()=>{
 const gateway=createGateway({frontendToken,agentToken,agentId,localTests:false});const a=await gateway.listen(0,'127.0.0.1');
 try{const r=await fetch(`http://127.0.0.1:${a.port}/status`,{headers:{Authorization:`Bearer ${frontendToken}`}});assert.equal(r.status,426);}finally{await gateway.close();}
});
