import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {DurableTaskRegistry,taskDigest,normalizedTaskScope} from '../src/task-tabs.mjs';
import {DurableActionLedger} from '../src/ledger.mjs';
import {BrowserController} from '../src/controller.mjs';
import {sha256} from '../src/safety.mjs';

const scope=(c='client',org='org1',r='ret1')=>({project:'Liming',clientRef:c,legalEntityRef:'entity1',entity:'Synthetic Entity',entityType:'Company',fy:'FY2026',period:'FY2026',formType:'CTR',matter:'2026 tax return',xeroOrgRef:org,xeroOrgLabel:'Xero Practice',returnRef:r});
const anchors=(r='ret1')=>({client:'Synthetic Entity',year:'FY2026',form:'Company Tax Return',organization:'Xero Practice',returnRef:r});
const url=r=>`https://go.xero.com/app/tax/${r}`;
const fails=(f,code)=>assert.rejects(f,e=>e.code===code);

test('same resource different Project/alias/matter has one canonical key, but another Xero org is isolated',()=>{
 assert.equal(taskDigest(scope()),taskDigest({...scope('alias'),project:'Another ChatGPT Project',matter:'Other memo'}));
 assert.notEqual(taskDigest(scope()),taskDigest(scope('client','org2')));
 assert.equal(taskDigest({...scope(),returnRef:'PENDING_RETURN'}),taskDigest({...scope('other-alias'),returnRef:'PENDING_RETURN'}));
});

test('two independent controllers cannot concurrently lease one Return across same journal or distinct journals sharing claim root',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bd050-race-'));
 try{
  const path=join(dir,'tasks.jsonl'),a=new DurableTaskRegistry(path),b=new DurableTaskRegistry(path),digest=taskDigest(scope());
  const outcomes=await Promise.allSettled([a.reserve(digest),b.reserve(digest)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
  assert.ok(['RESOURCE_LEASE_HELD','TASK_ALREADY_RESERVED'].includes(outcomes.find(x=>x.status==='rejected').reason.code));
  const rows=(await readFile(path,'utf8')).trim().split('\n');assert.equal(rows.length,1);
  const c=new DurableTaskRegistry(path);await fails(()=>c.reserve(digest),'TASK_ALREADY_RESERVED');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('durable action idempotency reserve is atomic before side effects; replay after restart is never repeated',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bd050-action-'));
 try{
  const path=join(dir,'actions.jsonl'),a=new DurableActionLedger(path),b=new DurableActionLedger(path);
  const key='same-action-key-123456',fp=sha256('exact-envelope');
  const outcome=await Promise.allSettled([a.reserve(key,fp,'click'),b.reserve(key,fp,'click')]);
  assert.equal(outcome.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcome.filter(x=>x.status==='rejected').length,1);
  const next=new DurableActionLedger(path);const cached=await next.get(key);assert.equal(cached.result.status,'UNCERTAIN_OUTCOME');
  await fails(()=>next.reserve(key,fp,'click'),'IDEMPOTENCY_CONFLICT');
 }finally{await rm(dir,{recursive:true,force:true});}
});

class FakeBrowser{
 constructor(){this.pages=new Map();this.created=0;this.installCalls=0;this.closed=[];}
 async createTab(address){const id=`plugin-${++this.created}`;this.pages.set(id,{id,url:address,current:{},saved:{},doc:1,guard:false,proof:''});return {id,url:address};}
 async tabs(){return [...this.pages.values()].map(x=>({id:x.id,title:'Synthetic',url:x.url}));}
 async closeTab(id){this.pages.delete(id);this.closed.push(id);return {closed:true};}
 async observe(id){const p=this.pages.get(id);return {url:p.url,title:'Synthetic Xero',visibleText:`Synthetic Entity FY2026 Company Tax Return Xero Practice ${new URL(p.url).pathname.split('/').pop()} ${p.proof}`,controls:[{label:'Save draft'}],viewport:{width:800,height:600}};}
 async installIdentityGuard(id){this.pages.get(id).guard=true;this.installCalls++;return {installed:true};}
 async lightweightProbe(id){const p=this.pages.get(id);return {url:p.url,guardInstalled:p.guard,guardDirty:false,documentToken:p.doc};}
 async readField(id,selector){const p=this.pages.get(id);return {count:1,exists:true,visible:true,enabled:true,readOnly:false,editable:true,label:'Synthetic field',value:p.current[selector]||'',url:p.url,documentToken:p.doc,guardInstalled:p.guard,guardDirty:false};}
 async setField(id,f){this.pages.get(id).current[f.selector]=f.text;}
 async describeTarget(){return {label:'Save draft',tag:'BUTTON',visible:true,inViewport:true,disabled:false};}
 async perform(id,action){const p=this.pages.get(id);if(action.kind==='click'){p.saved={...p.current};p.proof='Saved synthetic draft';}if(action.kind==='navigate'){p.url=action.url;p.doc++;}}
 async reload(id){const p=this.pages.get(id);p.current={...p.saved};p.doc++;p.guard=false;}
 async transaction(id,fn){return fn({observe:()=>this.observe(id),lightweightProbe:()=>this.lightweightProbe(id),readField:s=>this.readField(id,s),setField:f=>this.setField(id,f),describeTarget:a=>this.describeTarget(id,a),perform:a=>this.perform(id,a),reload:()=>this.reload(id),installIdentityGuard:a=>this.installIdentityGuard(id,a)});}
}
async function setup(){const b=new FakeBrowser(),c=new BrowserController(b,{localTests:true,profileAttested:true,requireManagedTasks:true});const open=await c.taskOpen({scope:scope(),startUrl:url('ret1')});const bind=await c.taskBind({taskId:open.taskId,anchors:anchors()});return {b,c,open,bind};}
async function persist(c,sessionId){await c.fillFields({sessionId,idempotencyKey:'fill-00000001',fields:[{selector:'#income',text:'100'}]});
 const save=await c.act({sessionId,idempotencyKey:'save-00000001',action:{kind:'click',selector:'#save'},expectedPoststate:{visibleTextIncludes:['Saved synthetic draft']}});
 const v=await c.verifySaved({sessionId,expectedRevision:save.after.revision,idempotencyKey:'reload-00000001',saveActionKey:'save-00000001',fields:[{selector:'#income',text:'100'}]});assert.equal(v.status,'DRAFT_PERSISTENCE_VERIFIED');}

test('reloaded document reinstalls scoped monitor before any follow-on batch, not during uninterrupted typing',async()=>{
 const {c,b,open,bind}=await setup();assert.equal(b.installCalls,1);
 await persist(c,bind.sessionId);assert.equal(b.installCalls,2,'exactly one reinstallation after new document');
 assert.equal(b.pages.get(open.tabId).guard,true);
 const again=await c.fillFields({sessionId:bind.sessionId,idempotencyKey:'follow-on-input-0001',fields:[{selector:'#income',text:'100'}]});
 assert.equal(again.status,'FIELD_VALUES_VERIFIED_UNSAVED');assert.equal(b.installCalls,2);
});

test('a subset of one form cannot be falsely declared whole tax return completed; independent signed review is mandatory',async()=>{
 const {c,b,open,bind}=await setup();await persist(c,bind.sessionId);
 await fails(()=>c.taskFinish({taskId:open.taskId,expectedFields:[{selector:'#income',text:'100'}],closeTab:false}),'FULL_RETURN_COVERAGE_MISSING');
 const plan=await c.taskPlan({taskId:open.taskId,sections:['income-section','deductions-section'],workpaperVersion:'source-revision-001'});
 await c.taskCheckpoint({taskId:open.taskId,sectionId:'income-section',verifyActionKey:'reload-00000001'});
 await fails(()=>c.taskFinish({taskId:open.taskId,expectedFields:[{selector:'#income',text:'100'}],closeTab:false}),'FULL_RETURN_COVERAGE_MISSING');
 await fails(()=>c.taskCheckpoint({taskId:open.taskId,sectionId:'deductions-section',verifyActionKey:'reload-00000001'}),'COVERAGE_REUSED_SAVE');
 const save2=await c.act({sessionId:bind.sessionId,idempotencyKey:'save-00000002',action:{kind:'click',selector:'#save'},expectedPoststate:{visibleTextIncludes:['Saved synthetic draft']}});
 const read2=await c.verifySaved({sessionId:bind.sessionId,expectedRevision:save2.after.revision,idempotencyKey:'reload-00000002',saveActionKey:'save-00000002',fields:[{selector:'#income',text:'100'}]});assert.equal(read2.status,'DRAFT_PERSISTENCE_VERIFIED');
 await c.taskCheckpoint({taskId:open.taskId,sectionId:'deductions-section',verifyActionKey:'reload-00000002'});
 await fails(()=>c.taskFinish({taskId:open.taskId,expectedFields:[{selector:'#income',text:'100'}],closeTab:true}),'DOMAIN_REVIEW_REQUIRED');
 const ui=await c.taskFinish({taskId:open.taskId,expectedFields:[{selector:'#income',text:'100'}],closeTab:false});
 assert.equal(ui.full_return_ready,false);assert.equal(b.closed.length,0);
 await fails(()=>c.taskClose({taskId:open.taskId}),'TASK_WRONG_STATE');
 await fails(()=>c.taskReviewApprove({taskId:open.taskId,reviewReceipt:{}}),'INDEPENDENT_VERIFIER_UNAVAILABLE');
 const kp=generateKeyPairSync('ed25519');c.reviewPublicKey=kp.publicKey;
 const record=await c.taskRegistry.getCoverage(open.taskId),coverageDigest=sha256(JSON.stringify(record.verified));
 const payload={taskDigest:c.managedTasks.get(open.taskId).digest,planDigest:plan.planDigest,coverageDigest,verdict:'PASS',verifier:'XERO_TAX_DOMAIN_REVIEW'};
 const sig=sign(null,Buffer.from(JSON.stringify(payload)),kp.privateKey).toString('base64');
 await fails(()=>c.taskReviewApprove({taskId:open.taskId,reviewReceipt:{...payload,signature:sig.slice(0,-6)+'abcdef'}}),'DOMAIN_REVIEW_SIGNATURE_INVALID');
 const ok=await c.taskReviewApprove({taskId:open.taskId,reviewReceipt:{...payload,signature:sig}});assert.equal(ok.tax_return_ready_for_human_review,true);
 await c.taskClose({taskId:open.taskId});assert.equal(b.closed.length,1);
});

test('new Return creation uses provisional resource lock and promotes only observable actual Return URL',async()=>{
 const b=new FakeBrowser(),c=new BrowserController(b,{localTests:true,profileAttested:true,requireManagedTasks:true});
 const provisional=await c.taskOpen({scope:{...scope(),returnRef:'PENDING_RETURN'},startUrl:url('PENDING_RETURN')});
 await fails(()=>c.taskPromoteReturn({taskId:provisional.taskId,returnRef:'ret-new'}),'RETURN_REF_UNPROVEN');
 b.pages.get(provisional.tabId).url=url('ret-new');
 const promoted=await c.taskPromoteReturn({taskId:provisional.taskId,returnRef:'ret-new'});assert.equal(promoted.state,'EXACT_RETURN_IDENTIFIED_PENDING_FIRST_BIND');
 const bind=await c.taskBind({taskId:provisional.taskId,anchors:anchors('ret-new')});assert.equal(bind.taskId,provisional.taskId);
 await fails(()=>c.taskOpen({scope:{...scope('other-alias'),returnRef:'ret-new'},startUrl:url('ret-new')}),'TASK_ALREADY_RESERVED');
});

test('deny generic Confirm/Continue/OK even without dangerous words, allow exact Save draft',async()=>{
 const {draftActionAllowlist}=await import('../src/safety.mjs');
 for(const label of ['Confirm','OK','Continue','Proceed','Final step'])
  assert.throws(()=>draftActionAllowlist({kind:'click',selector:'#action'},{tag:'BUTTON',label}),e=>e.code==='DRAFT_ACTION_UNCLASSIFIED');
 assert.equal(draftActionAllowlist({kind:'click',selector:'#save'},{tag:'BUTTON',label:'Save draft'}),true);
 assert.throws(()=>draftActionAllowlist({kind:'drag',x:1,y:1,toX:2,toY:2},{}),e=>e.code==='DRAFT_ACTION_UNCLASSIFIED');
});

test('durable provisional to real Return promotion releases only old claim; new canonical claim survives restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bd050-promote-'));
 try{
  const path=join(dir,'task.jsonl'),r=new DurableTaskRegistry(path);
  const oldDigest=taskDigest({...scope(),returnRef:'PENDING_RETURN'}),newDigest=taskDigest({...scope(),returnRef:'ret-new'});
  const reserved=await r.reserve(oldDigest);await r.transition(reserved.taskId,'CREATED',{tabId:'tab-synthetic-1'});
  const promoted=await r.promote(reserved.taskId,newDigest);assert.equal(promoted.scopeDigest,newDigest);
  assert.equal(await r.claims.check(newDigest,reserved.taskId),true);
  await fails(()=>r.claims.check(oldDigest,reserved.taskId),'RESOURCE_LEASE_UNVERIFIED');
  const replay=new DurableTaskRegistry(path);await fails(()=>replay.reserve(newDigest),'TASK_ALREADY_RESERVED');
 }finally{await rm(dir,{recursive:true,force:true});}
});
