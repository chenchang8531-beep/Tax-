import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChromeCDPBrowser} from '../src/cdp-browser.mjs';
import {BrowserController} from '../src/controller.mjs';

const TEST_HTML=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fake Xero</title></head><body>
<h1>Synthetic Entity Pty Ltd — FY2026 Draft</h1>
<label for="a">Amount A</label><input id="a" aria-label="Amount A"/>
<label for="b">Description</label><input id="b" aria-label="Description"/>
<label for="c">GST amount</label><input id="c" aria-label="GST amount"/>
<button id="save" onclick="document.getElementById('proof').textContent='Draft saved synthetic'">Save draft</button>
<button id="danger" onclick="document.getElementById('proof').textContent='FORBIDDEN'">Lodge Tax Return</button>
<div id="proof"></div></body></html>`;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Actual headless Chromium + DevTools Protocol, only isolated localhost synthetic HTML.
test('isolated Chromium CDP batch entry, click, risk gate and readback', {timeout:25000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'liming-chromium-'));
 const child=spawn('/usr/bin/chromium',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--no-proxy-server','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${dir}`,'about:blank'],{stdio:'ignore'});
 try{
  let cdpPort;
  for(let i=0;i<60;i++){try{const raw=await readFile(join(dir,'DevToolsActivePort'),'utf8');cdpPort=Number(raw.split('\n')[0]);if(cdpPort>0)break;}catch{}if(child.exitCode!==null)break;await delay(125);}
  assert.ok(cdpPort>0,'Chromium CDP must expose the isolated test port');
  const browser=new ChromeCDPBrowser({base:`http://127.0.0.1:${cdpPort}`,localTests:true});
  let tab;
  for(let i=0;i<60;i++){tab=(await browser.tabs()).find(t=>t.url==='about:blank');if(tab?.title==='Fake Xero')break;await delay(100);}
  assert.ok(tab,'Synthetic about:blank tab must be available');
  const initialized=await browser.withTab(tab.id,c=>browser.evaluate(c,`(()=>{document.write(${JSON.stringify(TEST_HTML)});document.close();return document.title;})()`));
  assert.equal(initialized,'Fake Xero');
  const controller=new BrowserController(browser,{localTests:true,profileAttested:true});
  let bound=await controller.bind({tabId:tab.id,scope:{project:'Liming',entity:'Synthetic Entity Pty Ltd',period:'FY2026',matter:'Draft ITR'},anchors:['Synthetic Entity Pty Ltd','FY2026']});
  const t0=performance.now();
  const fill=await controller.fillFields({sessionId:bound.sessionId,expectedRevision:bound.revision,idempotencyKey:'cdp-integration-0001',fields:[{selector:'#a',text:'1234.56'},{selector:'#b',text:'速度／中文 Xero'},{selector:'#c',text:'10'}]});
  const elapsedMs=Math.round(performance.now()-t0);
  assert.equal(fill.status,'FIELD_VALUES_VERIFIED_UNSAVED',JSON.stringify(fill));
  assert.equal((await browser.readField(tab.id,'#b')).value,'速度／中文 Xero');
  assert.equal((await browser.readField(tab.id,'#a')).value,'1234.56');
  const clean=await controller.observe({sessionId:bound.sessionId});
  const cleared=await controller.fillFields({sessionId:bound.sessionId,expectedRevision:clean.revision,idempotencyKey:'cdp-integration-0004',fields:[{selector:'#a',text:''}]});
  assert.equal(cleared.field_values_verified,true);assert.equal((await browser.readField(tab.id,'#a')).value,'');
  const s=await controller.observe({sessionId:bound.sessionId});
  await assert.rejects(()=>controller.act({sessionId:bound.sessionId,expectedRevision:s.revision,idempotencyKey:'cdp-integration-0002',action:{kind:'click',selector:'#danger'}}),e=>e.code==='IRREVERSIBLE_BLOCKED');
  const saved=await controller.act({sessionId:bound.sessionId,expectedRevision:s.revision,idempotencyKey:'cdp-integration-0003',action:{kind:'click',selector:'#save'},expectedPoststate:{visibleTextIncludes:['Draft saved synthetic']}});
  assert.equal(saved.status,'POSTSTATE_VERIFIED');
  console.log('ISOLATED_CHROMIUM_BULK_MS='+elapsedMs);
 } finally {
  child.kill('SIGTERM');await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,1500).unref();});
  await rm(dir,{recursive:true,force:true,maxRetries:2});
 }
});
