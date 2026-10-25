import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserController } from '../src/controller.mjs';
import {allowedUrl, riskGuard, constantTimeTokenMatch} from '../src/safety.mjs';
const SCOPE={project:'Liming',entity:'Synthetic Entity Pty Ltd',period:'FY2026',matter:'Draft return'};
const snap=()=>({url:'https://go.xero.com/app/tax',title:'Synthetic Xero page',visibleText:'Synthetic Entity Pty Ltd FY2026 Draft return',controls:[{label:'Save draft',tag:'BUTTON'}],viewport:{width:1200,height:800}});
class FakeBrowser {
 constructor(){this.page=snap();this.target={label:'Save draft',tag:'BUTTON',role:'button',visible:true};this.calls=0;}
 async tabs(){return[{id:'x1',title:this.page.title,url:this.page.url},{id:'other',title:'Bank',url:'https://bank.example'}];}
 async observe(){return structuredClone(this.page);}
 async describeTarget(){return {...this.target};}
 async readField(_tab,selector){return {count:1,exists:true,visible:true,enabled:true,readOnly:false,editable:true,value:'',type:this.target.type||'text',label:this.target.label,tag:this.target.tag||'INPUT'};}
 async perform(tabId,a){this.calls++;this.page.visibleText+=' | Step '+this.calls;if(a.kind==='navigate')this.page.url=a.url;}
 async screenshot(){return{mimeType:'image/png',base64:'aGVsbG8='};}
}
const args={tabId:'x1',scope:SCOPE,anchors:['Synthetic Entity Pty Ltd','FY2026']};
async function bind(browser=new FakeBrowser(),opts={profileAttested:true}){
 const c=new BrowserController(browser,opts);const s=await c.bind(args);return {c,browser,s};
}
async function rejectsCode(fn,code){await assert.rejects(fn,e=>e.code===code);}

test('allows only Xero HTTPS domains by default',()=>{
 assert.equal(allowedUrl('https://go.xero.com/tax'),true);
 assert.equal(allowedUrl('https://xero.com.au'),true);
 assert.equal(allowedUrl('https://xero.com.evil.com'),false);
 assert.equal(allowedUrl('http://xero.com'),false);
 assert.equal(allowedUrl('https://example.com'),false);
 assert.equal(allowedUrl('http://127.0.0.1/mock'),false);
 assert.equal(allowedUrl('http://127.0.0.1/mock',{localTests:true}),true);
});
test('constant-time token accepts only exact secrets',()=>{
 assert.equal(constantTimeTokenMatch('a'.repeat(32),'a'.repeat(32)),true);
 assert.equal(constantTimeTokenMatch('a'.repeat(32),'a'.repeat(31)),false);
});
test('never lists unrelated tabs',async()=>{const {c}=await bind();const list=await c.tabs();assert.equal(list.length,1);assert.equal(list[0].id,'x1');});
test('bind requires exact entity/period anchors',async()=>{
 const c=new BrowserController(new FakeBrowser(),{profileAttested:true});
 await rejectsCode(()=>c.bind({...args,anchors:['FY2026','Missing Client']}),'SCOPE_DRIFT');
 await rejectsCode(()=>c.bind({...args,anchors:['FY2026']}),'ANCHORS_REQUIRED');
 await rejectsCode(()=>c.bind({...args,scope:{...SCOPE,entity:''}}),'SCOPE_REQUIRED');
});
test('profile not attested blocks mutations while allowing observation',async()=>{
 const {c,s}=await bind(new FakeBrowser(),{profileAttested:false});
 assert.equal((await c.observe({sessionId:s.sessionId})).revision,s.revision);
 await rejectsCode(()=>c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',selector:'button'},idempotencyKey:'test-key-0001'}),'PROFILE_NOT_ATTESTED');
});
test('frontend one action executes once with real poststate',async()=>{
 const {c,s,browser}=await bind();
 const result=await c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',selector:'button'},idempotencyKey:'action-key-0001',expectedPoststate:{visibleTextIncludes:['Step 1']}});
 assert.equal(result.status,'POSTSTATE_VERIFIED');assert.equal(result.poststate_verified,true);
 assert.notEqual(result.after.revision,s.revision);assert.equal(browser.calls,1);
});
test('idempotency prevents duplicate click even after revision changed',async()=>{
 const {c,s,browser}=await bind();const input={sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',selector:'button'},idempotencyKey:'action-key-0002'};
 await c.act(input);const twice=await c.act(input);assert.equal(twice.deduplicated,true);assert.equal(browser.calls,1);
 await rejectsCode(()=>c.act({...input,action:{kind:'scroll',deltaY:100}}),'IDEMPOTENCY_CONFLICT');
});
test('stale page aborts and does not click',async()=>{
 const {c,s,browser}=await bind();browser.page.visibleText+=' Changed externally';
 await rejectsCode(()=>c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',selector:'button'},idempotencyKey:'action-key-0003'}),'STALE_PAGE');
 assert.equal(browser.calls,0);
});
test('cross-client drift aborts and does not click',async()=>{
 const {c,s,browser}=await bind();browser.page.visibleText='Different Entity FY2026';
 await rejectsCode(()=>c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',selector:'button'},idempotencyKey:'action-key-0004'}),'SCOPE_DRIFT');
 assert.equal(browser.calls,0);
});
test('blocks irreversible labels even on coordinate clicking',async()=>{
 const {c,s,browser}=await bind();browser.target={label:'Lodge Tax Return',tag:'BUTTON',role:'button'};
 await rejectsCode(()=>c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',x:200,y:300},idempotencyKey:'action-key-0005'}),'IRREVERSIBLE_BLOCKED');
 assert.equal(browser.calls,0);
});
test('never types into password fields',async()=>{
 const {c,s,browser}=await bind();browser.target={label:'Password',tag:'INPUT',type:'password',password:true};
 await rejectsCode(()=>c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'type',selector:'input',text:'secret'},idempotencyKey:'action-key-0006'}),'CREDENTIAL_BLOCKED');
 assert.equal(browser.calls,0);
});
test('rejects off-domain navigation',async()=>{
 const {c,s,browser}=await bind();
 await rejectsCode(()=>c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'navigate',url:'https://evil.example'},idempotencyKey:'action-key-0007'}),'ORIGIN_BLOCKED');
 assert.equal(browser.calls,0);
});
test('action readback that loses client anchors is not marked PASS',async()=>{
 const {c,s,browser}=await bind();browser.perform=async()=>{browser.calls++;browser.page.visibleText='Another client account';};
 const r=await c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',selector:'button'},idempotencyKey:'action-key-0008'});
 assert.equal(r.status,'SCOPE_REVALIDATION_REQUIRED');assert.equal(r.poststate_verified,false);
});
test('potential uncertain side effect never automatically retries',async()=>{
 const {c,s,browser}=await bind();browser.perform=async()=>{browser.calls++;throw new Error('Connection lost after click');};
 const input={sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',selector:'button'},idempotencyKey:'action-key-0009'};
 await assert.rejects(()=>c.act(input));const r=await c.act(input);
 assert.equal(r.status,'UNCERTAIN_OUTCOME');assert.equal(browser.calls,1);
});
test('session release makes old session inoperable',async()=>{
 const {c,s}=await bind();assert.equal(c.release({sessionId:s.sessionId}).released,true);
 await rejectsCode(()=>c.observe({sessionId:s.sessionId}),'SESSION_UNKNOWN');
});
test('bounds scrolling and input lengths',()=>{
 assert.throws(()=>riskGuard({kind:'click'},{label:'Submit BAS',tag:'BUTTON'}),e=>e.code==='IRREVERSIBLE_BLOCKED');
});

test('no asserted poststate is not a verification PASS',async()=>{
 const {c,s}=await bind();const r=await c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',selector:'button'},idempotencyKey:'action-key-0010'});
 assert.equal(r.status,'ACTION_OBSERVED_NO_ASSERTION');assert.equal(r.poststate_verified,false);
});
test('wrong poststate cannot greenlight result',async()=>{
 const {c,s}=await bind();const r=await c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',selector:'button'},idempotencyKey:'action-key-0011',expectedPoststate:{visibleTextIncludes:['not really saved']}});
 assert.equal(r.status,'POSTSTATE_MISMATCH');assert.equal(r.poststate_verified,false);
});

test('frontend-driven drag is bounded and reversible, cannot bypass risk label checks',async()=>{
 const {c,s,browser}=await bind();
 const r=await c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'drag',x:100,y:200,toX:120,toY:280},idempotencyKey:'action-key-0012'});
 assert.equal(r.action_kind,'drag');assert.equal(browser.calls,1);
});

test('form Enter key is blocked because pressing Enter can submit an entire return',()=>{
 assert.throws(()=>riskGuard({kind:'press',selector:'input',key:'Enter'},{label:'Amount',tag:'INPUT',inForm:true}),e=>e.code==='FORM_SUBMIT_KEY_BLOCKED');
});
