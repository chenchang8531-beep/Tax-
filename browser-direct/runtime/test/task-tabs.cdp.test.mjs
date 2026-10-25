import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ChromeCDPBrowser} from '../src/cdp-browser.mjs';
import {BrowserController} from '../src/controller.mjs';
const scope=i=>({project:'Liming',clientRef:'client-'+i,legalEntityRef:'entity-'+i,entity:'Synthetic '+i+' Pty Ltd',entityType:'Company',fy:'FY2026',period:'FY2026',formType:'CTR',matter:'Company Tax Return',xeroOrgRef:'org-'+i,xeroOrgLabel:'Practice Org',returnRef:'return-'+i});
const anchors=i=>({client:`Synthetic ${i} Pty Ltd`,year:'FY2026',form:'Company Tax Return',organization:'Practice Org',returnRef:'return-'+i});
const html=i=>`<!DOCTYPE html><html><title>Owned Test ${i}</title><body><h1 id="identity">Synthetic ${i} Pty Ltd FY2026 Company Tax Return Practice Org return-${i}</h1><label>Amount<input id="amount" aria-label="Amount"></label><button id="save" onclick="document.getElementById('proof').innerText='Saved synthetic draft'">Save draft</button><p id="proof"></p></body></html>`;
test('real Chromium CDP creates and closes ONLY owned tab, and watches other-client page replacement without per-step identity polling',{timeout:85000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'liming-managed-cdp-'));
 let child;let err='';
 try{
  child=spawn(process.env.LIMING_TEST_CHROMIUM||'/usr/bin/chromium',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--no-proxy-server','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${dir}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',data=>{err=(err+data.toString()).slice(-1300)});
  let port;const deadline=Date.now()+32000;
  while(Date.now()<deadline){try{const data=await readFile(join(dir,'DevToolsActivePort'),'utf8');port=Number(data.split('\n')[0]);if(port>0)break;}catch{}if(child.exitCode!==null)break;await delay(200);}
  assert.ok(port>0,'No isolated Chromium DevTools port: '+err);
  const browser=new ChromeCDPBrowser({base:`http://127.0.0.1:${port}`,localTests:true});
  const before=await browser.tabs();assert.ok(before.some(t=>t.url==='about:blank'));
  const c=new BrowserController(browser,{localTests:true,profileAttested:true,requireManagedTasks:true});
  const [a,b]=await Promise.all(['a','b'].map(i=>c.taskOpen({scope:scope(i),startUrl:'about:blank'})));
  assert.notEqual(a.tabId,b.tabId);assert.ok(!(before.some(t=>t.id===a.tabId||t.id===b.tabId)));
  await browser.withTab(a.tabId,async d=>browser.evaluate(d,`(()=>{document.open();document.write(${JSON.stringify(html('a'))});document.close();return document.title;})()`));
  await browser.withTab(b.tabId,async d=>browser.evaluate(d,`(()=>{document.open();document.write(${JSON.stringify(html('b'))});document.close();return document.title;})()`));
  const [ab,bb]=await Promise.all([c.taskBind({taskId:a.taskId,anchors:anchors('a')}),c.taskBind({taskId:b.taskId,anchors:anchors('b')})]);
  const filled=await Promise.all([c.fillFields({sessionId:ab.sessionId,idempotencyKey:'chromium-tab-a-fill-001',fields:[{selector:'#amount',text:'1000'}]}),c.fillFields({sessionId:bb.sessionId,idempotencyKey:'chromium-tab-b-fill-001',fields:[{selector:'#amount',text:'2000'}]})]);
  assert.ok(filled.every(r=>r.field_values_verified));
  assert.equal((await browser.readField(a.tabId,'#amount')).value,'1000');
  assert.equal((await browser.readField(b.tabId,'#amount')).value,'2000');
  // Simulate a React SPA silently replacing the on-page customer header with another client.
  await browser.withTab(a.tabId,d=>browser.evaluate(d,"(()=>{document.getElementById('identity').innerText='Different client FY2026 Company Tax Return Practice Org return-b';return true;})()"));
  const observedGuard=await browser.lightweightProbe(a.tabId);
  assert.equal(observedGuard.guardDirty,true);
  await assert.rejects(()=>c.fillFields({sessionId:ab.sessionId,idempotencyKey:'chromium-tab-a-fill-002',fields:[{selector:'#amount',text:'9999'}]}),e=>e.code==='TASK_REVALIDATION_REQUIRED');
  assert.equal((await browser.readField(a.tabId,'#amount')).value,'1000');
  assert.equal((await browser.readField(b.tabId,'#amount')).value,'2000');
  const extra=await c.taskOpen({scope:scope('c'),startUrl:'about:blank'});
  const close=await c.taskClose({taskId:extra.taskId});assert.equal(close.closed,true);
  const remaining=await browser.tabs();assert.equal(remaining.some(x=>x.id===extra.tabId),false);
  assert.equal(remaining.some(x=>x.id===a.tabId),true);assert.equal(remaining.some(x=>x.id===b.tabId),true);
  for(const original of before)assert.equal(remaining.some(t=>t.id===original.id),true);
 } finally {
   if(child){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(1800)]);}
   await rm(dir,{recursive:true,force:true,maxRetries:2});
 }
});
