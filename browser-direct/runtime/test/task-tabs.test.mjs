import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {generateKeyPairSync,sign} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../src/controller.mjs';
import {DurableTaskRegistry,normalizedTaskScope,taskDigest} from '../src/task-tabs.mjs';
const client=(i='a',ref='ret-001')=>({project:'Liming',clientRef:'client-'+i,legalEntityRef:'entity-'+i,entity:'Synthetic '+i+' Pty Ltd',entityType:'Company',fy:'FY2026',period:'FY2026',formType:'CTR',matter:'2026 tax return',xeroOrgRef:'org-'+i,xeroOrgLabel:'Practice Org',returnRef:ref});
const anchors=(i='a',ref='ret-001')=>({client:'Synthetic '+i+' Pty Ltd',year:'FY2026',form:'Company Tax Return',organization:'Practice Org',returnRef:ref});
const url=ref=>`https://go.xero.com/app/tax/${ref}`;
class MultiBrowser{
 constructor(){this.tabsMap=new Map([['preexisting',{id:'preexisting',url:url('other-999'),owner:'OTHER',current:{},saved:{},proof:'',doc:1}]]);this.created=0;this.closed=[];this.identityReads=0;this.changedOutside=false;}
 async tabs(){return [...this.tabsMap.values()].map(x=>({id:x.id,url:x.url,title:x.owner}));}
 async createTab(url){const id=`owned-${++this.created}`;const owner=new URL(url).pathname.split('/').pop().startsWith('ret-b')?'b':'a';this.tabsMap.set(id,{id,url,owner,current:{},saved:{},proof:'',doc:100+this.created});return {id,url};}
 async closeTab(id){if(!this.tabsMap.has(id))throw Error('Unknown browser tab');this.closed.push(id);this.tabsMap.delete(id);return {closed:true,tabId:id};}
 async observe(id){this.identityReads++;const b=this.tabsMap.get(id);if(!b)throw Error('TAB_MISSING');const [i,ref]=[b.owner,b.url.split('/').pop()];return {url:b.url,title:'Synthetic Xero Draft',visibleText:`Synthetic ${i} Pty Ltd FY2026 Company Tax Return Practice Org ${ref} ${b.proof}`,controls:[{label:'Save draft',tag:'BUTTON'}],viewport:{width:1200,height:700}};}
 async installIdentityGuard(id){if(!this.tabsMap.has(id))throw Error('TAB_MISSING');return {installed:true};}
 async lightweightProbe(id){const b=this.tabsMap.get(id);if(!b)throw Error('TAB_MISSING');return {url:b.url,documentToken:b.doc};}
 async readField(id,selector){const b=this.tabsMap.get(id);return {count:1,exists:true,visible:true,enabled:true,editable:true,readOnly:false,label:'Input',value:b.current[selector]||'',url:b.url,documentToken:b.doc};}
 async setField(id,f){this.tabsMap.get(id).current[f.selector]=f.text;}
 async describeTarget(){return {label:'Save draft',visible:true,disabled:false,inViewport:true,type:'button',tag:'BUTTON',formAction:'',pointerOccluded:false};}
 async perform(id,a){const b=this.tabsMap.get(id);if(a.kind==='click'){b.saved={...b.current};b.proof='Saved synthetic draft';}else if(a.kind==='navigate'){b.url=a.url;b.doc++;}else if(a.kind!=='wait')b.proof='Other action';}
 async reload(id){const b=this.tabsMap.get(id);b.current={...b.saved};b.doc++;}
 async transaction(id,fn){if(!this.tabsMap.has(id))throw Error('TAB_MISSING');return fn({observe:()=>this.observe(id),lightweightProbe:()=>this.lightweightProbe(id),readField:s=>this.readField(id,s),setField:f=>this.setField(id,f),describeTarget:a=>this.describeTarget(id,a),perform:a=>this.perform(id,a),reload:()=>this.reload(id)});}
}
async function start(i='a',ref='ret-001',browser=new MultiBrowser(),options={}){
 const c=new BrowserController(browser,{profileAttested:true,requireManagedTasks:true,...options});
 const opened=await c.taskOpen({scope:client(i,ref),startUrl:url(ref)});
 const bound=await c.taskBind({taskId:opened.taskId,anchors:anchors(i,ref)});
 return {c,browser,opened,bound};
}
const rejects=(fn,code)=>assert.rejects(fn,e=>e.code===code);
async function completeUI(c,taskId,verifyKey,expectedFields){
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');c.reviewPublicKey=publicKey;
 const plan=await c.taskPlan({taskId,sections:['income-section','deduction-section'],workpaperVersion:'synthetic-source-v0001'});
 await c.taskCheckpoint({taskId,sectionId:'income-section',verifyActionKey:verifyKey});
 const t=c.managedTasks.get(taskId),moreSave='second-save-'+verifyKey,moreRead='second-read-'+verifyKey;
 const saved=await c.act({sessionId:t.sessionId,idempotencyKey:moreSave,action:{kind:'click',selector:'#save'},expectedPoststate:{visibleTextIncludes:['Saved synthetic draft']}});
 const persisted=await c.verifySaved({sessionId:t.sessionId,expectedRevision:saved.after.revision,idempotencyKey:moreRead,saveActionKey:moreSave,fields:expectedFields});
 assert.equal(persisted.status,'DRAFT_PERSISTENCE_VERIFIED');
 await c.taskCheckpoint({taskId,sectionId:'deduction-section',verifyActionKey:moreRead});
 const ui=await c.taskFinish({taskId,expectedFields,closeTab:false});
 assert.equal(ui.state,'UI_AUDIT_COMPLETE_AWAITING_DOMAIN_REVIEW');
 const coverage=await c.taskRegistry.getCoverage(taskId);
 const coverageDigest=(await import('../src/safety.mjs')).sha256(JSON.stringify(coverage.verified));
 const payload={taskDigest:t.digest,planDigest:plan.planDigest,coverageDigest,verdict:'PASS',verifier:'XERO_TAX_DOMAIN_REVIEW'};
 const reviewReceipt={...payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),privateKey).toString('base64')};
 const review=await c.taskReviewApprove({taskId,reviewReceipt});assert.equal(review.state,'DOMAIN_REVIEW_VERIFIED');
 return {ui,review};
}

test('owned tab opens, binds exact client/FY/form/organisation/return; first and final identity checks only',async()=>{
 const {c,browser,opened,bound}=await start();
 assert.notEqual(opened.tabId,'preexisting');assert.equal(c.managedTasks.get(opened.taskId).identityChecks,1);
 const beforeReads=browser.identityReads;
 const fill=await c.fillFields({sessionId:bound.sessionId,idempotencyKey:'task-identity-fill-0001',fields:[{selector:'#income',text:'100'},{selector:'#expenses',text:'20'}]});
 assert.equal(fill.status,'FIELD_VALUES_VERIFIED_UNSAVED');assert.equal(browser.identityReads,beforeReads,'No full client identity read per field');
 assert.equal(c.managedTasks.get(opened.taskId).identityChecks,1);
 const save=await c.act({sessionId:bound.sessionId,idempotencyKey:'task-identity-save-0001',action:{kind:'click',selector:'#save'},expectedPoststate:{visibleTextIncludes:['Saved synthetic draft']}});
 assert.equal(save.status,'POSTSTATE_VERIFIED');assert.equal(c.managedTasks.get(opened.taskId).identityChecks,1);
 const verify=await c.verifySaved({sessionId:bound.sessionId,expectedRevision:save.after.revision,idempotencyKey:'task-identity-reload-0001',saveActionKey:'task-identity-save-0001',fields:[{selector:'#income',text:'100'},{selector:'#expenses',text:'20'}]});
 assert.equal(verify.status,'DRAFT_PERSISTENCE_VERIFIED');
 const {ui:final}=await completeUI(c,opened.taskId,'task-identity-reload-0001',[{selector:'#income',text:'100'},{selector:'#expenses',text:'20'}]);
 assert.equal(final.identity_checks,2);await c.taskClose({taskId:opened.taskId});
 assert.deepEqual(browser.closed,[opened.tabId]);assert.equal(browser.tabsMap.has('preexisting'),true);
});
test('concurrent different clients own separate tabs; same scope cannot be opened twice',async()=>{
 const browser=new MultiBrowser(),c=new BrowserController(browser,{profileAttested:true,requireManagedTasks:true});
 const [a,b]=await Promise.all([c.taskOpen({scope:client('a','ret-001'),startUrl:url('ret-001')}),c.taskOpen({scope:client('b','ret-b-002'),startUrl:url('ret-b-002')})]);
 assert.notEqual(a.tabId,b.tabId);
 await rejects(()=>c.taskOpen({scope:client('a','ret-001'),startUrl:url('ret-001')}),'TASK_ALREADY_RESERVED');
 const ab=await c.taskBind({taskId:a.taskId,anchors:anchors('a','ret-001')}),bb=await c.taskBind({taskId:b.taskId,anchors:anchors('b','ret-b-002')});
 const results=await Promise.all([c.fillFields({sessionId:ab.sessionId,idempotencyKey:'tab-a-entry-0001',fields:[{selector:'#amount',text:'500'}]}),c.fillFields({sessionId:bb.sessionId,idempotencyKey:'tab-b-entry-0001',fields:[{selector:'#amount',text:'600'}]})]);
 assert.ok(results.every(x=>x.field_values_verified));assert.equal(browser.tabsMap.get(a.tabId).current['#amount'],'500');assert.equal(browser.tabsMap.get(b.tabId).current['#amount'],'600');
 await rejects(()=>c.taskClose({taskId:a.taskId}),'TASK_WRONG_STATE');assert.equal(browser.tabsMap.has(b.tabId),true);
});
test('wrong FY, form, returnRef and organization anchors stop before any typing',async()=>{
 const browser=new MultiBrowser(),c=new BrowserController(browser,{profileAttested:true,requireManagedTasks:true});
 const a=await c.taskOpen({scope:client(),startUrl:url('ret-001')});
 await rejects(()=>c.taskBind({taskId:a.taskId,anchors:{...anchors(),year:'FY2025'}}),'TASK_YEAR_CONFLICT');
 await rejects(()=>c.taskBind({taskId:a.taskId,anchors:{...anchors(),form:'Individual Tax Return'}}),'TASK_FORM_CONFLICT');
 await rejects(()=>c.taskBind({taskId:a.taskId,anchors:{...anchors(),returnRef:'wrong-ref'}}),'SCOPE_DRIFT');
 await rejects(()=>c.taskBind({taskId:a.taskId,anchors:{...anchors(),organization:'Wrong Org'}}),'TASK_ORG_CONFLICT');
 assert.equal(c.sessions.size,0);assert.equal(browser.tabsMap.get(a.tabId).current['#amount'],undefined);
});
test('normal action stays fast; pause forces one re-check; foreign tab overlay stops before more writing',async()=>{
 const {c,browser,opened,bound}=await start();const task=c.managedTasks.get(opened.taskId);
 await c.fillFields({sessionId:bound.sessionId,idempotencyKey:'paused-entry-0001',fields:[{selector:'#amount',text:'200'}]});
 assert.equal(task.identityChecks,1);
 const pause=await c.taskPause({taskId:opened.taskId});assert.equal(pause.state,'PAUSED');
 await rejects(()=>c.fillFields({sessionId:bound.sessionId,idempotencyKey:'paused-entry-0002',fields:[{selector:'#amount',text:'999'}]}),'TASK_REVALIDATION_REQUIRED');
 const resumed=await c.taskResume({taskId:opened.taskId,anchors:anchors()});assert.equal(task.identityChecks,2);
 browser.tabsMap.get(opened.tabId).url=url('other-999');
 await rejects(()=>c.fillFields({sessionId:resumed.sessionId,idempotencyKey:'paused-entry-0003',fields:[{selector:'#amount',text:'999'}]}),'TASK_REVALIDATION_REQUIRED');
 assert.equal(task.state,'NEEDS_REVALIDATION');assert.equal(browser.tabsMap.get(opened.tabId).current['#amount'],'200');
 await rejects(()=>c.taskResume({taskId:opened.taskId,anchors:anchors()}),'SCOPE_DRIFT');
});
test('task finish refuses to close unsaved/unknown outcomes and unknown customer tabs',async()=>{
 const {c,browser,opened,bound}=await start();
 await rejects(()=>c.taskFinish({taskId:opened.taskId,expectedFields:[{selector:'#a',text:'10'}]}),'TASK_UNSAVED_OR_UNVERIFIED');
 await rejects(()=>c.taskClose({taskId:opened.taskId}),'TASK_WRONG_STATE');
 assert.equal(browser.closed.length,0);assert.equal(browser.tabsMap.has('preexisting'),true);
 await rejects(()=>c.taskClose({taskId:'random-task-id'}),'TASK_RECONCILIATION_REQUIRED');
 await rejects(()=>c.bind({tabId:'preexisting',scope:{project:'Liming',entity:'Other Client',period:'FY2026',matter:'Return'},anchors:['Other Client','FY2026']}),'MANAGED_TASK_REQUIRED');
 await c.taskPause({taskId:opened.taskId});assert.throws(()=>c.release({sessionId:bound.sessionId}),e=>e.code==='MANAGED_TASK_LIFECYCLE');
});
test('durable task ownership prevents duplicate open on process restart and requires full explicit recovery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'browser-task-registry-'));
 try{
  const path=join(dir,'tabs.jsonl'),browser=new MultiBrowser();
  const c=new BrowserController(browser,{profileAttested:true,requireManagedTasks:true,taskRegistry:new DurableTaskRegistry(path)});
  const a=await c.taskOpen({scope:client(),startUrl:url('ret-001')});await c.taskBind({taskId:a.taskId,anchors:anchors()});
  const raw=await readFile(path,'utf8');assert.ok(!raw.includes('Synthetic a Pty Ltd'));assert.ok(!raw.includes('FY2026'));assert.ok(!raw.includes('ret-001'));
  const next=new BrowserController(browser,{profileAttested:true,requireManagedTasks:true,taskRegistry:new DurableTaskRegistry(path)});
  await rejects(()=>next.taskOpen({scope:client(),startUrl:url('ret-001')}),'TASK_ALREADY_RESERVED');
  await rejects(()=>next.taskRecover({taskId:a.taskId,scope:client('b','ret-001'),anchors:anchors()}),'TASK_RECOVERY_BLOCKED');
  const recovered=await next.taskRecover({taskId:a.taskId,scope:client(),anchors:anchors()});assert.equal(recovered.state,'RESUMED_AFTER_REVALIDATION');
  assert.equal(browser.created,1);
 }finally{await rm(dir,{force:true,recursive:true});}
});
test('task scope rejects guessed year, unverified return identity and disallowed secrets',()=>{
 assert.throws(()=>normalizedTaskScope({...client(),fy:'2026ish'}),e=>e.code==='TASK_SCOPE_REQUIRED');
 assert.throws(()=>normalizedTaskScope({...client(),returnRef:'123456789'}),e=>e.code==='TASK_SCOPE_REQUIRED');
 assert.notEqual(taskDigest(client('a','ret-001')),taskDigest(client('b','ret-b-002')));
});

test('Chrome host identity readback occurs at task open and final/recovery, not every normal input',async()=>{
 const b=new MultiBrowser();let probes=0;
 const attestationGate={assertAllowed:async()=>{probes++;return {attested:true,fingerprint:'host-test'};},check:async()=>({attested:true})};
 const c=new BrowserController(b,{attestationGate,requireManagedTasks:true,localTests:true});
 const opened=await c.taskOpen({scope:client(),startUrl:url('ret-001')});
 await c.taskBind({taskId:opened.taskId,anchors:anchors()});
 assert.equal(probes,1);
 const t=c.managedTasks.get(opened.taskId),sid=t.sessionId;
 await c.fillFields({sessionId:sid,idempotencyKey:'host-check-fill-0001',fields:[{selector:'#amount',text:'100'}]});
 const save=await c.act({sessionId:sid,idempotencyKey:'host-check-save-0001',action:{kind:'click',selector:'#save'},expectedPoststate:{visibleTextIncludes:['Saved synthetic draft']}});
 const persisted=await c.verifySaved({sessionId:sid,expectedRevision:save.after.revision,idempotencyKey:'host-check-readback-0001',saveActionKey:'host-check-save-0001',fields:[{selector:'#amount',text:'100'}]});
 assert.equal(persisted.status,'DRAFT_PERSISTENCE_VERIFIED');
 assert.equal(probes,1,'No expensive host identity readback during uninterrupted typing, Save, or field-value verification');
 await completeUI(c,opened.taskId,'host-check-readback-0001',[{selector:'#amount',text:'100'}]);await c.taskClose({taskId:opened.taskId});
 assert.equal(probes,3,'Host checked at final and before owned tab close');
});
test('identity task key blocks duplicate same return despite different descriptive matter labels',async()=>{
 const b=new MultiBrowser(),c=new BrowserController(b,{profileAttested:true,requireManagedTasks:true});
 await c.taskOpen({scope:client(),startUrl:url('ret-001')});
 await rejects(()=>c.taskOpen({scope:{...client(),matter:'another memo label'},startUrl:url('ret-001')}),'TASK_ALREADY_RESERVED');
 assert.equal(b.created,1);
});

test('frontend may navigate only the owned unbound tab to a known Xero URL; pre-bind buttons and typing blocked',async()=>{
 const browser=new MultiBrowser(),c=new BrowserController(browser,{profileAttested:true,requireManagedTasks:true});
 const a=await c.taskOpen({scope:client(),startUrl:url('ret-001')});
 await rejects(()=>c.taskPrepare({taskId:a.taskId,idempotencyKey:'prep-input-deny-0001',action:{kind:'type',selector:'#amount',text:'100'}}),'TASK_PREPARE_READ_ONLY');
 await rejects(()=>c.taskPrepare({taskId:a.taskId,idempotencyKey:'prep-foreign-deny-0001',action:{kind:'navigate',url:'https://not-xero.example/client'}}),'ORIGIN_BLOCKED');
 // User-specified navigation is isolated to THIS created tab and protected by a durable action key.
 const prep=await c.taskPrepare({taskId:a.taskId,idempotencyKey:'prep-link-0001',action:{kind:'navigate',url:url('ret-001')}});
 assert.equal(prep.status,'PREPARING_NOT_YET_IDENTITY_BOUND');
 const duplicate=await c.taskPrepare({taskId:a.taskId,idempotencyKey:'prep-link-0001',action:{kind:'navigate',url:url('ret-001')}});
 assert.equal(duplicate.deduplicated,true);
 assert.equal(browser.tabsMap.has('preexisting'),true);
 await rejects(()=>c.taskClose({taskId:a.taskId}),'TASK_UNSAVED');
});

test('final close refuses changed/reused Chrome target and preserves other clients',async()=>{
 const {c,browser,opened,bound}=await start();
 await c.fillFields({sessionId:bound.sessionId,idempotencyKey:'changed-tab-fill-0001',fields:[{selector:'#amount',text:'200'}]});
 const save=await c.act({sessionId:bound.sessionId,idempotencyKey:'changed-tab-save-0001',action:{kind:'click',selector:'#save'},expectedPoststate:{visibleTextIncludes:['Saved synthetic draft']}});
 await c.verifySaved({sessionId:bound.sessionId,expectedRevision:save.after.revision,idempotencyKey:'changed-tab-reload-0001',saveActionKey:'changed-tab-save-0001',fields:[{selector:'#amount',text:'200'}]});
 const {ui:final}=await completeUI(c,opened.taskId,'changed-tab-reload-0001',[{selector:'#amount',text:'200'}]);
 assert.equal(final.state,'UI_AUDIT_COMPLETE_AWAITING_DOMAIN_REVIEW');
 browser.tabsMap.get(opened.tabId).doc++;
 await rejects(()=>c.taskClose({taskId:opened.taskId}),'TASK_TAB_CHANGED');
 assert.deepEqual(browser.closed,[]);
 assert.equal(browser.tabsMap.has(opened.tabId),true);
 assert.equal(browser.tabsMap.has('preexisting'),true);
});

test('after verified Save/reload, any later field entry invalidates finalisation until Save is verified again',async()=>{
 const {c,browser,opened,bound}=await start();
 await c.fillFields({sessionId:bound.sessionId,idempotencyKey:'later-write-fill-0001',fields:[{selector:'#amount',text:'200'}]});
 const save=await c.act({sessionId:bound.sessionId,idempotencyKey:'later-write-save-0001',action:{kind:'click',selector:'#save'},expectedPoststate:{visibleTextIncludes:['Saved synthetic draft']}});
 await c.verifySaved({sessionId:bound.sessionId,expectedRevision:save.after.revision,idempotencyKey:'later-write-reload-0001',saveActionKey:'later-write-save-0001',fields:[{selector:'#amount',text:'200'}]});
 await c.fillFields({sessionId:bound.sessionId,idempotencyKey:'later-write-fill-0002',fields:[{selector:'#amount',text:'300'}]});
 await rejects(()=>c.taskFinish({taskId:opened.taskId,expectedFields:[{selector:'#amount',text:'300'}]}),'TASK_UNSAVED_OR_UNVERIFIED');
 assert.equal(browser.closed.length,0);
});

test('task binding rejects a client name that conflicts with exact recorded legal entity even if form displays another client',async()=>{
 const browser=new MultiBrowser(),c=new BrowserController(browser,{profileAttested:true,requireManagedTasks:true});
 const opened=await c.taskOpen({scope:client(),startUrl:url('ret-001')});
 await rejects(()=>c.taskBind({taskId:opened.taskId,anchors:{...anchors(),client:'Synthetic b Pty Ltd'}}),'TASK_CLIENT_CONFLICT');
 assert.equal(c.managedTasks.get(opened.taskId).state,'CREATED');
});

// Australian FY boundaries and Xero organisation references must be exact.
test('exact FY-period controls reject inconsistent BAS and ITR dates, permit Australian FY2027 Q1',()=>{
 assert.throws(()=>normalizedTaskScope({...client(),fy:'FY2026',period:'FY2025'}),e=>e.code==='TASK_PERIOD_CONFLICT');
 assert.throws(()=>normalizedTaskScope({...client(),fy:'FY2026',period:'2026-07-01/2026-09-30'}),e=>e.code==='TASK_PERIOD_CONFLICT');
 assert.throws(()=>normalizedTaskScope({...client(),fy:'FY2027',period:'2026-07-01/2026-09-31'}),e=>e.code==='TASK_PERIOD_CONFLICT');
 const exact=normalizedTaskScope({...client(),fy:'FY2027',period:'2026-07-01/2026-09-30',formType:'BAS',xeroOrgRef:'!55Y1m'});
 assert.equal(exact.xeroOrgRef,'!55Y1m');
});
