import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserController} from '../src/controller.mjs';
const scope={project:'Liming',entity:'Synthetic Draft Pty Ltd',period:'FY2026',matter:'Tax Draft'};
const anchors=['Synthetic Draft Pty Ltd','FY2026'];
const page=()=>({url:'https://go.xero.com/app/tax',title:'Synthetic Xero Draft',visibleText:'Synthetic Draft Pty Ltd FY2026 Tax Draft',controls:[{label:'Save draft',tag:'BUTTON'}],viewport:{width:1280,height:800}});
class PersistBrowser{
 constructor(){this.current='';this.saved='';this.reloads=0;this.clicks=0;}
 async tabs(){return [{id:'tab',title:'Draft',url:page().url}];}
 async observe(){return page();}
 async describeTarget(){return {label:'Save draft',tag:'BUTTON',visible:true,disabled:false,formAction:'',pointerOccluded:false};}
 async perform(){this.saved=this.current;this.clicks++;}
 async readField(_,selector){if(selector!=='#a')return {count:0};return {count:1,exists:true,value:this.current,label:'Amount'};}
 async reload(){this.reloads++;this.current=this.saved;}
 async transaction(_,fn){return fn({observe:()=>this.observe(),describeTarget:()=>this.describeTarget(),perform:()=>this.perform(),readField:s=>this.readField(null,s),reload:()=>this.reload()});}
}
test('only verified Save on same session permits reload and exact persisted-field verification',async()=>{
 const b=new PersistBrowser();const c=new BrowserController(b,{profileAttested:true});const s=await c.bind({tabId:'tab',scope,anchors});
 await assert.rejects(()=>c.verifySaved({sessionId:s.sessionId,expectedRevision:s.revision,idempotencyKey:'verification-001',saveActionKey:'missing-save-001',fields:[{selector:'#a',text:'100'}]}),e=>e.code==='SAVE_PROOF_REQUIRED');
 b.current='100';const save=await c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',selector:'#save'},idempotencyKey:'test-save-action-0001',expectedPoststate:{visibleTextIncludes:['Tax Draft']}});
 assert.equal(save.status,'POSTSTATE_VERIFIED');
 const verified=await c.verifySaved({sessionId:s.sessionId,expectedRevision:save.after.revision,idempotencyKey:'verification-002',saveActionKey:'test-save-action-0001',fields:[{selector:'#a',text:'100'}]});
 assert.equal(verified.status,'DRAFT_PERSISTENCE_VERIFIED');assert.equal(b.reloads,1);
 const repeated=await c.verifySaved({sessionId:s.sessionId,expectedRevision:save.after.revision,idempotencyKey:'verification-002',saveActionKey:'test-save-action-0001',fields:[{selector:'#a',text:'100'}]});assert.equal(repeated.deduplicated,true);assert.equal(b.reloads,1);
});
test('reload mismatch never claims persistence success and never automatically retries write',async()=>{
 const b=new PersistBrowser();const c=new BrowserController(b,{profileAttested:true});const s=await c.bind({tabId:'tab',scope,anchors});
 b.current='10';const save=await c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',selector:'#save'},idempotencyKey:'test-save-action-0002',expectedPoststate:{visibleTextIncludes:['Tax Draft']}});
 b.saved='9';const v=await c.verifySaved({sessionId:s.sessionId,expectedRevision:save.after.revision,idempotencyKey:'verification-003',saveActionKey:'test-save-action-0002',fields:[{selector:'#a',text:'10'}]});
 assert.equal(v.status,'PERSISTENCE_MISMATCH');assert.equal(v.poststate_verified,false);assert.equal(b.reloads,1);assert.equal(b.clicks,1);
});
test('new attestation provider blocks UI mutation when current PID/profiling cannot be proved',async()=>{
 const b=new PersistBrowser();const c=new BrowserController(b,{localTests:true,attestationGate:{check:async()=>({attested:false}),assertAllowed:async()=>{const e=new Error('Mismatch');e.code='PROFILE_NOT_ATTESTED';throw e;}}});
 const s=await c.bind({tabId:'tab',scope,anchors});const status=await c.status();assert.equal(status.profile_attested,false);
 await assert.rejects(()=>c.act({sessionId:s.sessionId,expectedRevision:s.revision,action:{kind:'click',selector:'#save'},idempotencyKey:'test-save-action-0003'}),e=>e.code==='PROFILE_NOT_ATTESTED');
 assert.equal(b.clicks,0);
});
