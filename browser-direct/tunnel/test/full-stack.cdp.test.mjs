import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ChromeCDPBrowser} from '../../runtime/src/cdp-browser.mjs';
import {BrowserController} from '../../runtime/src/controller.mjs';
import {createServer} from '../../runtime/src/mcp-server.mjs';
import {createGateway} from '../gateway.mjs';
import {WindowsTunnelAgent} from '../agent.mjs';

const FRONT='front-test-token-'.repeat(4),AGENT='agent-test-token-'.repeat(4),LOCAL='local-test-token-'.repeat(4),AGENT_ID='synthetic-windows-agent';
const HTML=`<!doctype html><html><head><title>Synthetic Xero Draft</title></head><body>
<h1>Synthetic Xero Company — FY2026 Draft</h1>
<label for="amount">Amount</label><input id="amount" aria-label="Amount" value=""/>
<label for="memo">Memo</label><input id="memo" aria-label="Memo" value=""/>
<button id="save" onclick="document.getElementById('proof').textContent='Draft saved synthetic'">Save draft</button>
<button id="lodge" onclick="document.getElementById('proof').textContent='ILLEGAL'">Lodge Tax Return</button>
<p id="proof"></p>
</body></html>`;
function stop(server){return new Promise(r=>server.close(r));}

test('full MCP over local tunnel -> real isolated Chromium field entry and Save poststate; reload is verified separately with synthetic persisted adapter', {timeout:105000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'liming-full-cdp-'));let child,local,gateway;
 try{
  const executable=process.env.LIMING_TEST_CHROMIUM||'/usr/bin/chromium';let stderr='';
  child=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--no-proxy-server','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${dir}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',c=>{stderr=(stderr+String(c)).slice(-1500);});
  let port;const deadline=Date.now()+32000;
  while(Date.now()<deadline){try{const v=await readFile(join(dir,'DevToolsActivePort'),'utf8');port=Number(v.split('\n')[0]);if(port>0)break;}catch{}if(child.exitCode!==null)break;await delay(200);}
  assert.ok(port>0,'Isolated Chromium did not bind CDP: '+stderr);
  const browser=new ChromeCDPBrowser({base:`http://127.0.0.1:${port}`,localTests:true});
  const tabs=await browser.tabs(),blank=tabs.find(t=>t.url==='about:blank');assert.ok(blank);
  const init=await browser.withTab(blank.id,c=>browser.evaluate(c,`(()=>{document.write(${JSON.stringify(HTML)});document.close();return document.title;})()`));
  assert.equal(init,'Synthetic Xero Draft');
  const c=new BrowserController(browser,{localTests:true,profileAttested:true});
  local=createServer({token:LOCAL,controller:c,port:0});const la=await local.listen();
  gateway=createGateway({frontendToken:FRONT,agentToken:AGENT,agentId:AGENT_ID,localTests:true,clientTimeoutMs:21000,waitNextMs:4000});const ga=await gateway.listen(0);
  const remote=`http://127.0.0.1:${ga.port}`;
  const agent=new WindowsTunnelAgent({gatewayUrl:remote,agentToken:AGENT,agentId:AGENT_ID,localToken:LOCAL,localUrl:`http://127.0.0.1:${la.port}/mcp`,localTests:true});
  let rpcid=10;
  async function tool(name,args={}){
   const pending=agent.step();await delay(30);
   const rr=await fetch(`${remote}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${FRONT}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:rpcid++,method:'tools/call',params:{name,arguments:args}})});
   assert.equal(rr.status,200,`Gateway returned HTTP ${rr.status}`);const json=await rr.json();const ack=await pending;assert.equal(ack.reported,true);
   const response=json.result;if(response.isError)throw Error('Tool '+name+' returned '+JSON.stringify(response.content));
   return JSON.parse(response.content[0].text);
  }
  const listing=await tool('browser_tabs');const tab=listing.find(t=>t.id===blank.id);assert.ok(tab);
  const bind=await tool('browser_bind',{tabId:blank.id,scope:{project:'Liming',entity:'Synthetic Xero Company',period:'FY2026',matter:'Draft'},anchors:['Synthetic Xero Company','FY2026']});
  const fill=await tool('browser_fill_fields',{sessionId:bind.sessionId,expectedRevision:bind.revision,idempotencyKey:'fullstack-fill-0001',fields:[{selector:'#amount',text:'2510.45'},{selector:'#memo',text:'全链路验证'}]});
  assert.equal(fill.status,'FIELD_VALUES_VERIFIED_UNSAVED');
  const observed=await tool('browser_observe',{sessionId:bind.sessionId});
  const save=await tool('browser_act',{sessionId:bind.sessionId,expectedRevision:observed.revision,idempotencyKey:'fullstack-save-0001',action:{kind:'click',selector:'#save'},expectedPoststate:{visibleTextIncludes:['Draft saved synthetic']}});
  assert.equal(save.status,'POSTSTATE_VERIFIED');
  // This environment's Chromium policy blocks localhost/data navigation (ERR_BLOCKED_BY_ADMINISTRATOR).
  // The separate persistence adapter tests verify the real controller's Save -> reload -> compare logic.
  const final=await tool('browser_observe',{sessionId:bind.sessionId});
  await assert.rejects(()=>tool('browser_act',{sessionId:bind.sessionId,expectedRevision:final.revision,idempotencyKey:'fullstack-lodge-0001',action:{kind:'click',selector:'#lodge'}}),/IRREVERSIBLE_BLOCKED/);
  await tool('browser_release',{sessionId:bind.sessionId});
 }finally{
  if(gateway){gateway.server.closeAllConnections?.();await gateway.close();}if(local){local.server.closeAllConnections?.();await stop(local.server);}
  if(child){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(1500)]);}
  await rm(dir,{force:true,recursive:true,maxRetries:2});
 }
});
