import test from 'node:test';
import assert from 'node:assert/strict';
import {createGateway} from '../gateway.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
 const gateway=createGateway({frontendToken,agentToken,agentId,localTests:false,journalPath:join(tmpdir(),'liming-browser-gw-http-test-050.jsonl')});const a=await gateway.listen(0,'127.0.0.1');
 try{const r=await fetch(`http://127.0.0.1:${a.port}/status`,{headers:{Authorization:`Bearer ${frontendToken}`}});assert.equal(r.status,426);}finally{await gateway.close();}
});

test('spoofed X-Forwarded-Proto cannot make direct plaintext transport pass production TLS check',async()=>{
 const gateway=createGateway({frontendToken,agentToken,agentId,localTests:false,journalPath:join(tmpdir(),'liming-browser-gw-http-test-050.jsonl')});const a=await gateway.listen(0,'127.0.0.1');
 try{const r=await fetch(`http://127.0.0.1:${a.port}/status`,{headers:{Authorization:`Bearer ${frontendToken}`,'X-Forwarded-Proto':'https'}});
  assert.equal(r.status,426);const body=await r.json();assert.equal(body.error,'END_TO_END_TLS_REQUIRED');}
 finally{await gateway.close();}
});

test('gateway durable request journal survives a restart and never automatically resends uncertain work',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bd050-gateway-'));const journalPath=join(dir,'jobs.jsonl');
 const f=await fixture();
 try{
  // A separate new local synthetic gateway is used to exercise the durable journal.
  const g=createGateway({frontendToken,agentToken,agentId,localTests:true,journalPath,waitNextMs:500});
  const a=await g.listen(0);const url=`http://127.0.0.1:${a.port}`;
  try{
    // Establish an authenticated agent heartbeat via an outstanding poll.
    const poll=fetch(url+'/agent/next',{headers:{Authorization:`Bearer ${agentToken}`,'X-Liming-Agent-Id':agentId}});
    await delay(30);
    const mcp=fetch(url+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${frontendToken}`,'Content-Type':'application/json'},body:JSON.stringify(rpc(77,'ping'))});
    const work=await poll;assert.equal(work.status,200);const job=await work.json();
    const entry=await fetch(url+'/result/'+job.requestId,{headers:{Authorization:`Bearer ${frontendToken}`}});assert.equal((await entry.json()).status,'UNCERTAIN_OUTCOME_NO_AUTO_REPLAY');
    const ack=await fetch(url+'/agent/reply',{method:'POST',headers:{Authorization:`Bearer ${agentToken}`,'X-Liming-Agent-Id':agentId,'Content-Type':'application/json'},body:JSON.stringify({requestId:job.requestId,response:{jsonrpc:'2.0',id:77,result:{ok:true}}})});assert.equal(ack.status,200);
    const result=await mcp;assert.equal(result.status,200);
    await g.close();
    const restarted=createGateway({frontendToken,agentToken,agentId,localTests:true,journalPath});const b=await restarted.listen(0);try{
      const status=await fetch(`http://127.0.0.1:${b.port}/result/${job.requestId}`,{headers:{Authorization:`Bearer ${frontendToken}`}});
      const json=await status.json();assert.equal(json.status,'REPLY_COMMITTED');assert.equal(json.responseDigest.length,64);assert.equal(restarted.status().queued,0);
    }finally{await restarted.close();}
  }catch(e){try{await g.close();}catch{}throw e;}
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
