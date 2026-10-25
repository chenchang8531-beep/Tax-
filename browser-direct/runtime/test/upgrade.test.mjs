import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../src/controller.mjs';
import {DurableActionLedger} from '../src/ledger.mjs';
import {retryRead} from '../src/retry.mjs';

const scope={project:'Liming',entity:'Synthetic Test Pty Ltd',period:'FY2026',matter:'Tax Draft'};
const anchors=['Synthetic Test Pty Ltd','FY2026'];
function snapshot(){return {url:'https://go.xero.com/app/tax',title:'Synthetic Xero Draft',visibleText:'Synthetic Test Pty Ltd FY2026 Tax Draft',controls:[{label:'Save draft',tag:'BUTTON'}],viewport:{width:1280,height:800}};}
class FormBrowser {
 constructor(){this.fields=new Map([['#a',''],['#b',''],['#c',''],['#pw','']]);this.writes=[];this.transactions=0;this.page=snapshot();this.modes={};this.failOnce=false;}
 async tabs(){return[{id:'test',url:this.page.url,title:this.page.title}];}
 async observe(){return structuredClone(this.page);}
 async readField(_tab,selector){return this.state(selector);}
 state(selector){return {selector,count:1,exists:true,visible:true,enabled:true,editable:true,readOnly:false,type:selector==='#pw'?'password':'text',tag:'INPUT',label:selector==='\#pw'?'Password':'Ordinary field',value:this.fields.get(selector)??''};}
 async describeTarget(_tab,{selector}){const s=this.state(selector);return {label:s.label,tag:s.tag,type:s.type,visible:true,disabled:false,password:s.type==='password',x:10,y:10};}
 async setField(_tab,field,mode){this.writes.push({selector:field.selector,mode});if(this.failOnce){this.failOnce=false;throw new Error('Transient write uncertainty');}
   if(mode==='fast'&&this.modes[field.selector]==='unchanged')return;
   if(mode==='fast'&&this.modes[field.selector]==='partial'){this.fields.set(field.selector,field.text.slice(0,2));return;}
   this.fields.set(field.selector,field.text);
 }
 async transaction(_tab,callback){this.transactions++;return callback({observe:()=>this.observe(),readField:s=>this.readField(null,s),setField:(f,m)=>this.setField(null,f,m),describeTarget:a=>this.describeTarget(null,a)});}
}
function input(browser,session,fields,key='bulk-test-idempotency-0001'){return {sessionId:session.sessionId,expectedRevision:session.revision,idempotencyKey:key,fields};}
async function setup(browser=new FormBrowser(),opts={}){const c=new BrowserController(browser,{profileAttested:true,...opts});const s=await c.bind({tabId:'test',scope,anchors});return {c,s,browser};}

test('multi-field action uses one CDP transaction and verifies exact values, not just page text',async()=>{
 const {c,s,browser}=await setup();const r=await c.fillFields(input(browser,s,[{selector:'#a',text:'你好 World'},{selector:'#b',text:'123.45'},{selector:'#c',text:'100'}]));
 assert.equal(browser.transactions,1);assert.equal(browser.writes.length,3);assert.deepEqual(browser.writes.map(x=>x.mode),['fast','fast','fast']);
 assert.equal(r.status,'FIELD_VALUES_VERIFIED_UNSAVED');assert.equal(r.field_values_verified,true);assert.equal(r.poststate_verified,false);assert.equal(r.fields.length,3);
 assert.equal(JSON.stringify(r).includes('你好 World'),false);
});
test('already-correct field is skipped and idempotency does not replay writes',async()=>{
 const {c,s,browser}=await setup();browser.fields.set('#a','10');const args=input(browser,s,[{selector:'#a',text:'10'},{selector:'#b',text:'20'}],'bulk-test-idempotency-0002');
 const first=await c.fillFields(args);const second=await c.fillFields(args);
 assert.equal(first.fields[0].status,'ALREADY_MATCHED');assert.equal(browser.writes.length,1);assert.equal(second.deduplicated,true);
});
test('fall back to keyed typing exactly once only if original field is unchanged',async()=>{
 const {c,s,browser}=await setup();browser.modes['#a']='unchanged';const r=await c.fillFields(input(browser,s,[{selector:'#a',text:'ABC'}],'bulk-test-idempotency-0003'));
 assert.equal(r.status,'FIELD_VALUES_VERIFIED_UNSAVED');assert.deepEqual(browser.writes.map(x=>x.mode),['fast','keyed']);
});
test('partially modified field never triggers blind retry or fallback',async()=>{
 const {c,s,browser}=await setup();browser.modes['#a']='partial';const r=await c.fillFields(input(browser,s,[{selector:'#a',text:'ABCD'},{selector:'#b',text:'keep'}],'bulk-test-idempotency-0004'));
 assert.equal(r.status,'PARTIAL_STOP');assert.equal(r.fields[0].status,'FIELD_MISMATCH_NO_RETRY');assert.equal(browser.writes.length,1);
});
test('uncertain CDP failure never replays a typed side effect on retry',async()=>{
 const {c,s,browser}=await setup();browser.failOnce=true;const args=input(browser,s,[{selector:'#a',text:'something'}],'bulk-test-idempotency-0005');
 await assert.rejects(()=>c.fillFields(args));const result=await c.fillFields(args);
 assert.equal(result.status,'UNCERTAIN_OUTCOME');assert.equal(browser.writes.length,1);
});
test('block passwords and do not mutate any fields when prior page revision is stale',async()=>{
 const {c,s,browser}=await setup();browser.page.visibleText+=' moved to a different form';
 await assert.rejects(()=>c.fillFields(input(browser,s,[{selector:'#a',text:'x'}],'bulk-test-idempotency-0006')),e=>e.code==='STALE_PAGE');
 assert.equal(browser.writes.length,0);
 const fresh=await c.observe({sessionId:s.sessionId});
 await assert.rejects(()=>c.fillFields({sessionId:s.sessionId,expectedRevision:fresh.revision,idempotencyKey:'bulk-test-idempotency-0007',fields:[{selector:'#pw',text:'password'}]}),e=>e.code==='CREDENTIAL_BLOCKED');
 assert.equal(browser.writes.length,0);
});
test('refuse ambiguous selector and avoid fallback if target is not precisely identified',async()=>{
 const {c,s,browser}=await setup();browser.readField=async()=>({...browser.state('#a'),count:2});
 const result=await c.fillFields(input(browser,s,[{selector:'#a',text:'X'}],'bulk-test-idempotency-0008'));
 assert.equal(result.status,'PARTIAL_STOP');assert.equal(result.fields[0].status,'AMBIGUOUS_FIELD');assert.equal(browser.writes.length,0);
});
test('durable WAL prevents replay across controller process restart without storing typed text',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'liming-browser-wal-'));const path=join(dir,'actions.jsonl');
 try{
  const browser=new FormBrowser();const ledger=new DurableActionLedger(path);const {c,s}=await setup(browser,{ledger});
  const args=input(browser,s,[{selector:'#a',text:'SENSITIVE_CLIENT_VALUE'}],'bulk-test-idempotency-0009');
  const result=await c.fillFields(args);assert.equal(result.field_values_verified,true);
  const contents=await readFile(path,'utf8');assert.equal(contents.includes('SENSITIVE_CLIENT_VALUE'),false);
  const next=new BrowserController(browser,{profileAttested:true,ledger:new DurableActionLedger(path)});
  const replay=await next.fillFields(args);assert.equal(replay.deduplicated,true);assert.equal(browser.writes.length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('read-only retries transient errors with bounded attempts; never retries non-transient errors',async()=>{
 let n=0;const r=await retryRead(()=>{n++;if(n<3){const e=new Error('transient');e.code='CDP_DISCONNECTED';throw e;}return 'ok';},{delays:[1,1]});
 assert.equal(r,'ok');assert.equal(n,3);let bad=0;
 await assert.rejects(()=>retryRead(()=>{bad++;const e=new Error('scope');e.code='SCOPE_DRIFT';throw e;},{delays:[1,1]}));assert.equal(bad,1);
});

test('final audit catches reactive form rerender that silently resets an earlier value',async()=>{
 const {c,s,browser}=await setup();const original=browser.setField.bind(browser);
 browser.setField=async(tab,field,mode)=>{await original(tab,field,mode);if(field.selector==='#b')browser.fields.set('#a','');};
 const result=await c.fillFields(input(browser,s,[{selector:'#a',text:'111'},{selector:'#b',text:'222'}],'bulk-test-idempotency-0010'));
 assert.equal(result.status,'PARTIAL_STOP');assert.ok(result.fields.some(f=>f.status==='FIELD_REVERTED_AFTER_BATCH'));
});
test('explicit fallback selector is permitted only when unique and expected label matches',async()=>{
 const {c,s,browser}=await setup();browser.fields.set('#alt','');
 const original=browser.readField.bind(browser);
 browser.readField=async(tab,selector)=>selector==='#missing'?{count:0,exists:false}:selector==='#alt'?{...browser.state('#alt'),label:'Current Taxable Income'}:original(tab,selector);
 browser.describeTarget=async(_tab,{selector})=>({...browser.state(selector),label:selector==='#alt'?'Current Taxable Income':'Other'});
 const result=await c.fillFields(input(browser,s,[{selector:'#missing',fallbackSelector:'#alt',expectedLabel:'Taxable Income',text:'525'}],'bulk-test-idempotency-0011'));
 assert.equal(result.status,'FIELD_VALUES_VERIFIED_UNSAVED');assert.equal(browser.writes[0].selector,'#alt');
});
test('fallback selector mismatch must stop before typing',async()=>{
 const {c,s,browser}=await setup();
 browser.readField=async(_tab,selector)=>selector==='#missing'?{count:0,exists:false}:{...browser.state('#alt'),label:'Other company'};
 const result=await c.fillFields(input(browser,s,[{selector:'#missing',fallbackSelector:'#alt',expectedLabel:'Taxable Income',text:'525'}],'bulk-test-idempotency-0012'));
 assert.equal(result.status,'PARTIAL_STOP');assert.equal(browser.writes.length,0);
});
test('corrupt durable WAL fails closed instead of allowing replay',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'liming-browser-badwal-')),path=join(dir,'log.jsonl');
 try{await import('node:fs/promises').then(fs=>fs.writeFile(path,'{bad-record}\n'));
  const ledger=new DurableActionLedger(path);
  await assert.rejects(()=>ledger.get('some-old-key'),e=>e.code==='LEDGER_CORRUPT');
 }finally{await rm(dir,{recursive:true,force:true});}
});
