import {randomUUID,verify as verifySignature} from 'node:crypto';
import {ControlError,allowedUrl,requireExactScope,riskGuard,draftActionAllowlist,snapshotRevision,validateAction,sha256} from './safety.mjs';
import {MemoryActionLedger} from './ledger.mjs';
import {retryRead} from './retry.mjs';
import {normalizedTaskScope,taskDigest,normalizeIdentityAnchors,assertTaskIdentity,MemoryTaskRegistry} from './task-tabs.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const MAX_FIELDS=12;

function checkKey(idempotencyKey){if(typeof idempotencyKey!=='string'||idempotencyKey.length<10||idempotencyKey.length>128)throw new ControlError('IDEMPOTENCY_REQUIRED','A 10-128 character idempotency key is required');}
function checkRevision(expectedRevision){if(typeof expectedRevision!=='string'||!/^[a-f0-9]{64}$/.test(expectedRevision))throw new ControlError('REVISION_REQUIRED','A 64-byte hex page revision is required');}
function validateFields(fields){
 if(!Array.isArray(fields)||!fields.length||fields.length>MAX_FIELDS)throw new ControlError('BAD_FIELDS','Fill batch must have 1-12 fields');
 const selectors=new Set();let total=0;
 return fields.map((f,i)=>{
  if(!f||typeof f!=='object'||Array.isArray(f))throw new ControlError('BAD_FIELDS','Each field must be an object');
  if(Object.keys(f).some(k=>!['selector','text','fallbackSelector','expectedLabel'].includes(k)))throw new ControlError('BAD_FIELDS','Unrecognized field property');
  validateAction({kind:'type',selector:f.selector,text:f.text});
  if(selectors.has(f.selector))throw new ControlError('BAD_FIELDS','Duplicate field selector is unsafe');selectors.add(f.selector);
  if(f.fallbackSelector!==undefined){
   if(typeof f.fallbackSelector!=='string'||!f.fallbackSelector||f.fallbackSelector.length>400||f.fallbackSelector===f.selector)throw new ControlError('BAD_FIELDS','Invalid fallback selector');
   if(typeof f.expectedLabel!=='string'||f.expectedLabel.trim().length<3||f.expectedLabel.length>130)throw new ControlError('BAD_FIELDS','A fallback requires an exact expected label');
   if(selectors.has(f.fallbackSelector))throw new ControlError('BAD_FIELDS','Selector reused as another field fallback');selectors.add(f.fallbackSelector);
  }
  total+=Buffer.byteLength(f.text,'utf8');if(total>24000)throw new ControlError('BAD_FIELDS','Batch payload exceeds 24KB');
  return Object.freeze({selector:f.selector,text:f.text,fallbackSelector:f.fallbackSelector,expectedLabel:f.expectedLabel,index:i});
 });
}
function validatePredicate(predicate){
 if(predicate===undefined||predicate===null)return null;
 if(typeof predicate!=='object'||Array.isArray(predicate))throw new ControlError('BAD_PREDICATE','Poststate predicate must be an object');
 const accepted=['url','visibleTextIncludes','visibleTextExcludes','controlsIncludeLabel'];
 if(Object.keys(predicate).some(k=>!accepted.includes(k)))throw new ControlError('BAD_PREDICATE','Unrecognized poststate predicate');
 if(typeof predicate.url!=='undefined'&&(typeof predicate.url!=='string'||predicate.url.length>500))throw new ControlError('BAD_PREDICATE','Invalid expected URL');
 for(const key of accepted.slice(1))if(predicate[key]!==undefined&&(!Array.isArray(predicate[key])||predicate[key].length>6||predicate[key].some(x=>typeof x!=='string'||x.length<2||x.length>140)))throw new ControlError('BAD_PREDICATE','Invalid expected labels');
 if(!Object.values(predicate).some(x=>x!==undefined&&(!Array.isArray(x)||x.length)))throw new ControlError('BAD_PREDICATE','At least one assertion required');
 return predicate;
}
function assertPoststate(after,predicate){
 if(predicate.url&&after.url!==predicate.url)return false;
 const text=after.visibleText.toLocaleLowerCase();
 if(predicate.visibleTextIncludes?.some(x=>!text.includes(x.toLocaleLowerCase())))return false;
 if(predicate.visibleTextExcludes?.some(x=>text.includes(x.toLocaleLowerCase())))return false;
 const labels=after.controls.map(x=>String(x.label||'').toLocaleLowerCase());
 if(predicate.controlsIncludeLabel?.some(x=>!labels.some(l=>l.includes(x.toLocaleLowerCase()))))return false;
 return true;
}

export class BrowserController {
 constructor(browser,{profileAttested=false,attestationGate=null,localTests=false,now=Date.now,sessionTtlMs=30*60*1000,ledger=new MemoryActionLedger({now}),taskRegistry=new MemoryTaskRegistry(),requireManagedTasks=false,reviewPublicKey=null,contextVerifier=null,writerLeaseVerifier=null,obligationVerifier=null}={}){
  this.browser=browser;this.profileAttested=profileAttested;this.attestationGate=attestationGate;this.localTests=localTests;this.now=now;this.sessionTtlMs=sessionTtlMs;
  this.sessions=new Map();this.currentLocks=new Set();this.currentKeys=new Set();this.actionLedger=ledger;
  this.taskRegistry=taskRegistry;this.requireManagedTasks=requireManagedTasks;this.reviewPublicKey=reviewPublicKey;this.contextVerifier=contextVerifier;this.writerLeaseVerifier=writerLeaseVerifier;this.obligationVerifier=obligationVerifier;this.managedTasks=new Map();this.tabOwners=new Map();this.openKeys=new Set();
 }
 async assertAuthorizedWrite({sessionId=null,force=false}={}){
  // OS owner/profile attestation is performed when the task OPENS and again at RESUME/FINAL.
  // During uninterrupted filling, the exact task-owned Chrome target and inexpensive document watcher guard continuity.
  if(sessionId&&!force){const bound=this.sessions.get(sessionId),task=bound?.managedTaskId&&this.managedTasks.get(bound.managedTaskId);
    if(task&&task.state==='BOUND'&&!bound.invalidated&&task.openingHostAttested===true)
      return {attested:true,reason:'UNCHANGED_TASK_LEASE; LIVE_TAB_GUARDED_SEPARATELY',fingerprint:task.hostFingerprint??null};
  }
  if(this.attestationGate){
    if(!this.localTests){
      if(typeof this.writerLeaseVerifier!=='function')throw new ControlError('WRITER_BROKER_UNAVAILABLE','Production requires verified exclusive Chrome writer coordination',503);
      if(typeof this.contextVerifier!=='function')throw new ControlError('CONTEXT_VERIFIER_UNAVAILABLE','Project current-state verifier must be installed',503);
      const st=sessionId?this.sessions.get(sessionId):null;
      if(st?.managedTaskId){const task=this.managedTasks.get(st.managedTaskId);const result=await this.contextVerifier(task?.contextBinding);
        if(result?.current!==true)throw new ControlError('STALE_PROJECT_BINDING','Current Project/workpaper revision cannot be verified',409);}
      const receipt=await this.writerLeaseVerifier({taskId:st?.managedTaskId||null});
      if(receipt?.exclusive!==true)throw new ControlError('WRITER_BROKER_UNAVAILABLE','Exclusive writer not attested',409);
    }
    return this.attestationGate.assertAllowed();
  }
  if(!this.profileAttested)throw new ControlError('PROFILE_NOT_ATTESTED','Chrome 9222 process owner must be independently attested',403);
  return {attested:true,reason:'INJECTED_TEST_ATTESTATION'};
 }
 async status(){
  const owner=this.attestationGate?await this.attestationGate.check():{attested:this.profileAttested,reason:this.localTests?'SYNTHETIC_TEST':'NO_LIVE_OWNER_PROBE'};
  let cdp_reachable=false,xero_tabs_count=0,cdp_error=null;
  try{const tabs=await this.tabs();cdp_reachable=true;xero_tabs_count=tabs.length;}catch(e){cdp_error=e.code||'CDP_NOT_AVAILABLE';}
  return {server:'initialized',cdp_target:'127.0.0.1:9222',cdp_reachable,xero_tabs_count,cdp_error,
   profile_attested:owner.attested===true,owner_attestation:{reason:owner.reason,pid:owner.pid??null,fingerprint:owner.fingerprint??null,observed_at:owner.observedAt??null},mode:'frontend_directed',scope:'Xero-only',backend_planner:false,tunnel_proven:false,
   bulk_fill_max_fields:MAX_FIELDS,write_retry_policy:'readback-before-fallback; no blind replay',wal_durable:this.actionLedger.constructor.name==='DurableActionLedger'};
 }
 async tabs(){const tabs=await retryRead(()=>this.browser.tabs());return tabs.filter(t=>allowedUrl(t.url,{localTests:this.localTests})).map(t=>({id:t.id,title:t.title,url:t.url}));}
 async bind({tabId,scope,anchors}){
  if(this.requireManagedTasks)throw new ControlError('MANAGED_TASK_REQUIRED','Production actions require owned task/client/FY/form binding',403);
  if(this.tabOwners.has(tabId))throw new ControlError('TAB_OWNED','Another managed task owns this tab',409);
  const exact=requireExactScope(scope);
  if(typeof tabId!=='string'||tabId.length>120)throw new ControlError('TAB_REQUIRED','Exact tabId required');
  if(!Array.isArray(anchors)||anchors.length<2||anchors.length>6||anchors.some(x=>typeof x!=='string'||x.trim().length<3||x.length>130))throw new ControlError('ANCHORS_REQUIRED','2-6 exact visible anchor strings required');
  if([...new Set(anchors.map(s=>s.toLowerCase()))].length!==anchors.length)throw new ControlError('ANCHORS_REQUIRED','Anchor strings must be different');
  const available=await this.tabs();if(!available.some(t=>t.id===tabId))throw new ControlError('TAB_MISMATCH','Tab is unavailable or origin is not allowed',403);
  const snap=await retryRead(()=>this.browser.observe(tabId));this.checkSnapshot(snap,anchors);
  const sessionId=randomUUID();this.sessions.set(sessionId,{tabId,scope:exact,anchors:[...anchors],expiresAt:this.now()+this.sessionTtlMs});
  return this.present(sessionId,snap);
 }
 checkSnapshot(snap,anchors){
  if(!snap||!allowedUrl(snap.url,{localTests:this.localTests}))throw new ControlError('ORIGIN_DRIFT','Tab has left the approved origin',403);
  if(!Array.isArray(snap.controls)||typeof snap.visibleText!=='string')throw new ControlError('BAD_SNAPSHOT','Invalid browser observation',502);
  const text=`${snap.title||''}\n${snap.visibleText}`.toLocaleLowerCase();
  const missing=anchors.filter(a=>!text.includes(a.toLocaleLowerCase()));
  if(missing.length)throw new ControlError('SCOPE_DRIFT','Expected entity/period/page anchors are no longer visible',409);
 }
 getSession(sessionId){const s=this.sessions.get(sessionId);if(!s)throw new ControlError('SESSION_UNKNOWN','Bind tab before control',404);
  if(this.now()>s.expiresAt){this.sessions.delete(sessionId);if(s.managedTaskId){const t=this.managedTasks.get(s.managedTaskId);if(t){t.state='NEEDS_REVALIDATION';t.persistedCounter=null;}}throw new ControlError('SESSION_EXPIRED','Browser bind expired; managed task requires identity revalidation',409);}
  if(s.managedTaskId&&(s.invalidated||this.managedTasks.get(s.managedTaskId)?.state!=='BOUND'))throw new ControlError('TASK_REVALIDATION_REQUIRED','Managed task paused or interrupted; run task_resume',409);return s;}
 present(sessionId,snap){return {sessionId,revision:snapshotRevision(snap),tab:{id:this.getSession(sessionId).tabId,url:snap.url,title:snap.title},
    visibleText:snap.visibleText.slice(0,12000),controls:snap.controls.slice(0,150),viewport:snap.viewport,profileAttested:this.attestationGate?null:this.profileAttested,profileCheck:'initial_exception_final_for_managed_task'};}
 async observe({sessionId,screenshot=false}){
  const s=this.getSession(sessionId);const snap=await retryRead(()=>this.browser.observe(s.tabId));if(!s.managedTaskId)this.checkSnapshot(snap,s.anchors);s.expiresAt=this.now()+this.sessionTtlMs;
  const result=this.present(sessionId,snap);
  if(screenshot)result.screenshot=await retryRead(()=>this.browser.screenshot(s.tabId));return result;
 }
 async driver(tabId,fn){
  if(typeof this.browser.transaction==='function')return this.browser.transaction(tabId,fn);
  return fn({observe:()=>this.browser.observe(tabId),describeTarget:a=>this.browser.describeTarget(tabId,a),
    perform:(a,el)=>this.browser.perform(tabId,a,el),
    readField:s=>this.browser.readField(tabId,s),setField:(f,mode)=>this.browser.setField(tabId,f,mode),
    lightweightProbe:()=>this.browser.lightweightProbe?.(tabId),reload:()=>this.browser.reload?.(tabId)});
 }
 async ensureNotBusy(s,key,fingerprint){
  const cached=await this.actionLedger.get(key);
  if(cached){if(cached.fingerprint!==fingerprint)throw new ControlError('IDEMPOTENCY_CONFLICT','Key already used for a different operation',409);
    return {...cached.result,deduplicated:true};}
  if(this.currentKeys.has(key)||this.currentLocks.has(s.tabId))throw new ControlError('TAB_BUSY','Action already running on tab or key',409);
  return null;
 }
 async act({sessionId,expectedRevision,action,idempotencyKey,expectedPoststate}){
  checkKey(idempotencyKey);if(expectedRevision!==undefined)checkRevision(expectedRevision);
  await this.assertAuthorizedWrite({sessionId});
  const a=validateAction(action),predicate=validatePredicate(expectedPoststate);
  if(a.kind==='type'){
    const fill=await this.fillFields({sessionId,expectedRevision,idempotencyKey,fields:[{selector:a.selector,text:a.text}]});
    return {...fill,action_kind:'type',typed_value_verified:fill.field_values_verified,poststate_verified:false};
  }
  const fingerprint=sha256(JSON.stringify({type:'act',sessionId,expectedRevision,action:a,expectedPoststate:predicate}));
  const cached=await this.actionLedger.get(idempotencyKey);
  if(cached){if(cached.fingerprint!==fingerprint)throw new ControlError('IDEMPOTENCY_CONFLICT','Key already used for a different action',409);return {...cached.result,deduplicated:true};}
  const s=this.getSession(sessionId);
  if(!s.managedTaskId&&!expectedRevision)throw new ControlError('REVISION_REQUIRED','Legacy session needs exact page revision');
  if(this.currentLocks.has(s.tabId)||this.currentKeys.has(idempotencyKey))throw new ControlError('TAB_BUSY','Another action is in progress',409);
  this.currentLocks.add(s.tabId);this.currentKeys.add(idempotencyKey);
  try{
   const result=await this.driver(s.tabId,async d=>{
     const before=s.managedTaskId?null:await retryRead(()=>d.observe());
     if(s.managedTaskId)await this.assertManagedStable(s,d);else{this.checkSnapshot(before,s.anchors);
       if(snapshotRevision(before)!==expectedRevision)throw new ControlError('STALE_PAGE','Page changed since observation; reobserve first',409);}
     if(a.kind==='navigate'&&!allowedUrl(a.url,{localTests:this.localTests}))throw new ControlError('ORIGIN_BLOCKED','Only Xero origins allowed',403);
     const element=['click','double_click','hover','drag','type','press','select'].includes(a.kind)?await d.describeTarget(a):{};
     riskGuard(a,element);
     if(s.managedTaskId&&!this.localTests)draftActionAllowlist(a,element);
     await this.actionLedger.reserve(idempotencyKey,fingerprint,a.kind);
     if(a.kind==='wait')await sleep(a.ms);else await d.perform(a,element);
     const after=await retryRead(()=>d.observe());let status='ACTION_OBSERVED_NO_ASSERTION';
     try{if(s.managedTaskId)await this.assertManagedStable(s,d);else this.checkSnapshot(after,s.anchors);if(predicate)status=assertPoststate(after,predicate)?'POSTSTATE_VERIFIED':'POSTSTATE_MISMATCH';}
     catch{status='SCOPE_REVALIDATION_REQUIRED';}
     return {status,action_id:idempotencyKey,action_kind:a.kind,sessionTag:sha256(sessionId),after:{revision:snapshotRevision(after),url:after.url,title:after.title},
       observation_returned:true,poststate_verified:status==='POSTSTATE_VERIFIED',deduplicated:false};
   });
   await this.actionLedger.commit(idempotencyKey,fingerprint,result);
   if(s.managedTaskId){const t=this.managedTasks.get(s.managedTaskId);if(t&&!['wait','scroll','hover'].includes(a.kind)){t.mutationCounter++;t.persistedCounter=null;if(result.status==='SCOPE_REVALIDATION_REQUIRED')await this.markTaskDirty(t,'POST_ACTION_NAVIGATION_DRIFT');}}
   s.expiresAt=this.now()+this.sessionTtlMs;return result;
  }catch(e){if(s.managedTaskId&& !['IRREVERSIBLE_BLOCKED','CREDENTIAL_BLOCKED','BAD_ACTION','UNKNOWN_TARGET'].includes(e.code)){await this.markTaskDirty(this.managedTasks.get(s.managedTaskId),'ACTION_EXCEPTION');}throw e;}
  finally{this.currentKeys.delete(idempotencyKey);this.currentLocks.delete(s.tabId);await this.actionLedger.prune();}
 }
 async fillFields({sessionId,expectedRevision,idempotencyKey,fields}){
  checkKey(idempotencyKey);if(expectedRevision!==undefined)checkRevision(expectedRevision);
  await this.assertAuthorizedWrite({sessionId});
  const requested=validateFields(fields);
  const fingerprint=sha256(JSON.stringify({type:'fill',sessionId,expectedRevision,fields:requested}));
  const cached=await this.actionLedger.get(idempotencyKey);
  if(cached){if(cached.fingerprint!==fingerprint)throw new ControlError('IDEMPOTENCY_CONFLICT','Key reused with different fields',409);return {...cached.result,deduplicated:true};}
  const s=this.getSession(sessionId);
  if(!s.managedTaskId&&!expectedRevision)throw new ControlError('REVISION_REQUIRED','Legacy session needs exact page revision');
  if(this.currentLocks.has(s.tabId)||this.currentKeys.has(idempotencyKey))throw new ControlError('TAB_BUSY','Another action is in progress',409);
  this.currentLocks.add(s.tabId);this.currentKeys.add(idempotencyKey);
  let reserved=false;
  try{
   const result=await this.driver(s.tabId,async d=>{
    const before=s.managedTaskId?null:await retryRead(()=>d.observe());
    if(s.managedTaskId)await this.assertManagedStable(s,d);else{this.checkSnapshot(before,s.anchors);
      if(snapshotRevision(before)!==expectedRevision)throw new ControlError('STALE_PAGE','Page changed since observation; reobserve first',409);}
    const reports=[];const finalAudit=[];let stopped=false;
    for(const f of requested){
      if(!s.managedTaskId){const current=await retryRead(()=>d.observe());
      try{this.checkSnapshot(current,s.anchors);}catch{reports.push({index:f.index,status:'SCOPE_REVALIDATION_REQUIRED'});stopped=true;break;}}
      let selected=f.selector;let input=await retryRead(()=>d.readField(selected));
      if(input?.count===0&&f.fallbackSelector){
        selected=f.fallbackSelector;input=await retryRead(()=>d.readField(selected));
        if(!input||input.count!==1||!String(input.label||'').toLocaleLowerCase().includes(f.expectedLabel.toLocaleLowerCase())){reports.push({index:f.index,status:'FALLBACK_IDENTITY_MISMATCH'});stopped=true;break;}
      }
      if(s.managedTaskId)this.assertFieldStillSameTask(s,input);
      if(!input||input.count!==1||!input.exists){reports.push({index:f.index,status:'AMBIGUOUS_FIELD'});stopped=true;break;}
      const target=await d.describeTarget({kind:'type',selector:selected});riskGuard({kind:'type',selector:selected},target);
      if(selected!==f.selector&&!String(target.label||'').toLocaleLowerCase().includes(f.expectedLabel.toLocaleLowerCase())){reports.push({index:f.index,status:'FALLBACK_IDENTITY_MISMATCH'});stopped=true;break;}
      const resolved={...f,selector:selected};
      if(!input.visible||!input.enabled||input.readOnly||!input.editable){reports.push({index:f.index,status:'FIELD_UNAVAILABLE'});stopped=true;break;}
      if(input.value===f.text){reports.push({index:f.index,status:'ALREADY_MATCHED'});finalAudit.push({index:f.index,selector:selected,text:f.text});continue;}
      if(!reserved){await this.actionLedger.reserve(idempotencyKey,fingerprint,'fill_fields');reserved=true;}
      await d.setField(resolved,'fast');
      let actual=await retryRead(()=>d.readField(selected));
      if(s.managedTaskId)this.assertFieldStillSameTask(s,actual);
      if(actual.count!==1||!actual.exists){reports.push({index:f.index,status:'TARGET_DRIFT_AFTER_INPUT'});stopped=true;break;}
      if(actual.value===f.text){reports.push({index:f.index,status:'VALUE_VERIFIED',mode:'fast'});finalAudit.push({index:f.index,selector:selected,text:f.text});continue;}
      // Fallback is allowed only if a real readback proves that fast entry made no change.
      if(actual.value===input.value){
        if(s.managedTaskId){await this.assertManagedStable(s,d);}else{const afterInput=await retryRead(()=>d.observe());
        try{this.checkSnapshot(afterInput,s.anchors);}catch{reports.push({index:f.index,status:'SCOPE_REVALIDATION_REQUIRED'});stopped=true;break;}}
        await d.setField(resolved,'keyed');actual=await retryRead(()=>d.readField(selected));
        if(actual.count===1&&actual.value===f.text){reports.push({index:f.index,status:'VALUE_VERIFIED',mode:'keyed'});finalAudit.push({index:f.index,selector:selected,text:f.text});continue;}
      }
      reports.push({index:f.index,status:'FIELD_MISMATCH_NO_RETRY'});stopped=true;break;
    }
    let after;
    try{if(s.managedTaskId){await this.assertManagedStable(s,d);}else{after=await retryRead(()=>d.observe());this.checkSnapshot(after,s.anchors);}}catch{stopped=true;}
    if(!stopped){for(const f of finalAudit){
      try{const final=await retryRead(()=>d.readField(f.selector));if(final?.count!==1||final.value!==f.text){reports.push({index:f.index,status:'FIELD_REVERTED_AFTER_BATCH'});stopped=true;break;}}
      catch{reports.push({index:f.index,status:'FINAL_AUDIT_UNAVAILABLE'});stopped=true;break;}
    }}
    const status=stopped?'PARTIAL_STOP':'FIELD_VALUES_VERIFIED_UNSAVED';
    return {status,action_id:idempotencyKey,action_kind:'fill_fields',sessionTag:sha256(sessionId),fields:reports,
      field_values_verified:!stopped&&reports.length===requested.length,poststate_verified:false,
      observation_returned:Boolean(after),after:after?{revision:snapshotRevision(after)}:undefined,deduplicated:false};
   });
   await this.actionLedger.commit(idempotencyKey,fingerprint,result);
   if(s.managedTaskId){const t=this.managedTasks.get(s.managedTaskId);if(t){t.mutationCounter++;t.persistedCounter=null;if(result.status==='PARTIAL_STOP')await this.markTaskDirty(t,'BATCH_PARTIAL_OR_UNCERTAIN');}}
   s.expiresAt=this.now()+this.sessionTtlMs;return result;
  }catch(e){if(s.managedTaskId){await this.markTaskDirty(this.managedTasks.get(s.managedTaskId),'BATCH_EXCEPTION');}throw e;}
  finally{this.currentKeys.delete(idempotencyKey);this.currentLocks.delete(s.tabId);await this.actionLedger.prune();}
 }
 async verifySaved({sessionId,expectedRevision,idempotencyKey,saveActionKey,fields}){
  checkKey(idempotencyKey);checkKey(saveActionKey);checkRevision(expectedRevision);
  const s=this.getSession(sessionId);
  if(!Array.isArray(fields)||fields.length<1||fields.length>MAX_FIELDS||fields.some(f=>!f||typeof f.selector!=='string'||typeof f.text!=='string'||f.selector.length>400||f.text.length>4096))throw new ControlError('BAD_FIELDS','1-12 exact field selectors and values required');
  const fingerprint=sha256(JSON.stringify({type:'verify_saved',sessionId,expectedRevision,saveActionKey,fields}));
  const prior=await this.actionLedger.get(idempotencyKey);
  if(prior){if(prior.fingerprint!==fingerprint)throw new ControlError('IDEMPOTENCY_CONFLICT','Verification key reused with different inputs',409);return {...prior.result,deduplicated:true};}
  const saved=await this.actionLedger.get(saveActionKey);
  if(!saved||saved.result?.status!=='POSTSTATE_VERIFIED'||saved.result?.action_kind!=='click'||saved.result?.sessionTag!==sha256(sessionId))throw new ControlError('SAVE_PROOF_REQUIRED','Same-session Save action with verified poststate required before reload',409);
  // Reload can discard unsaved values: it is allowed only after the caller supplies a verified Save receipt.
  await this.assertAuthorizedWrite({sessionId});
  if(this.currentLocks.has(s.tabId)||this.currentKeys.has(idempotencyKey))throw new ControlError('TAB_BUSY','Browser tab already controlled',409);
  this.currentLocks.add(s.tabId);this.currentKeys.add(idempotencyKey);
  try{
   const result=await this.driver(s.tabId,async d=>{
    const before=await retryRead(()=>d.observe());this.checkSnapshot(before,s.anchors);
    if(snapshotRevision(before)!==expectedRevision)throw new ControlError('STALE_PAGE','Page changed before reload verification',409);
    if(typeof d.reload!=='function')throw new ControlError('RELOAD_UNSUPPORTED','Browser driver cannot reload and verify persistence',503);
    await this.actionLedger.reserve(idempotencyKey,fingerprint,'verify_saved');
    const oldProbe=typeof d.lightweightProbe==='function'?await d.lightweightProbe():null;
    await d.reload();
    let after;
    try{
      const newProbe=typeof d.lightweightProbe==='function'?await d.lightweightProbe():null;
      if(oldProbe?.documentToken!=null&&newProbe?.documentToken===oldProbe.documentToken)
        throw new ControlError('RELOAD_NOT_NEW_DOCUMENT','Reload did not establish a new document',409);
      after=await retryRead(()=>d.observe());this.checkSnapshot(after,s.anchors);
      if(s.managedTaskId){
        const t=await this.requireOwnedTask(s.managedTaskId,['BOUND']);
        this.ensureTaskAnchors(t,t.anchors,after);
        if(typeof d.installIdentityGuard==='function')await d.installIdentityGuard(Object.values(t.anchors),t.formGuard);
        else if(typeof this.browser.installIdentityGuard==='function')await this.browser.installIdentityGuard(t.tabId,Object.values(t.anchors),t.formGuard);
        else throw new ControlError('TASK_GUARD_UNAVAILABLE','Cannot install guard after reload',409);
        const installed=typeof d.lightweightProbe==='function'?await d.lightweightProbe():await this.captureTaskProbe(t);
        if((installed?.guardInstalled===false||(!this.localTests&&this.browser.constructor.name==='ChromeCDPBrowser'&&installed?.guardInstalled!==true))||installed?.guardDirty)throw new ControlError('TASK_GUARD_UNAVAILABLE','Reload lost the scoped active-form guard',409);
      }
    }catch(e){
      return {status:'SCOPE_REVALIDATION_REQUIRED',action_id:idempotencyKey,action_kind:'verify_saved',sessionTag:sha256(sessionId),poststate_verified:false,observation_returned:false};
    }
    const report=[];
    for(let i=0;i<fields.length;i++){
      let field;
      try{field=await retryRead(()=>d.readField(fields[i].selector));}catch(e){report.push({index:i,status:'READBACK_UNAVAILABLE'});break;}
      report.push({index:i,status:field?.count===1&&field.value===fields[i].text?'PERSISTED_VALUE_MATCH':'PERSISTED_VALUE_MISMATCH'});
      if(report.at(-1).status!=='PERSISTED_VALUE_MATCH')break;
    }
    const ok=report.length===fields.length&&report.every(x=>x.status==='PERSISTED_VALUE_MATCH');
    return {status:ok?'DRAFT_PERSISTENCE_VERIFIED':'PERSISTENCE_MISMATCH',action_id:idempotencyKey,action_kind:'verify_saved',sessionTag:sha256(sessionId),fields:report,
      poststate_verified:ok,observation_returned:true,after:{revision:snapshotRevision(after),url:after.url},deduplicated:false};
   });
   await this.actionLedger.commit(idempotencyKey,fingerprint,result);
   if(s.managedTaskId){const t=this.managedTasks.get(s.managedTaskId);if(t){if(result.status==='DRAFT_PERSISTENCE_VERIFIED'){t.persistedCounter=t.mutationCounter;const p=await this.captureTaskProbe(t);s.boundProbe=p;s.boundUrl=p.url;}else await this.markTaskDirty(t,'PERSISTENCE_OR_IDENTITY_FAILURE');}}
   s.expiresAt=this.now()+this.sessionTtlMs;return result;
  }finally{this.currentKeys.delete(idempotencyKey);this.currentLocks.delete(s.tabId);await this.actionLedger.prune();}
 }
  // Scoped, owned Chrome tab lifecycle. No pre-existing or other client's tab is adopted.
  async taskOpen({scope,startUrl,contextBinding=null}){
    const exact=normalizedTaskScope(scope),digest=taskDigest(exact);
    if(!this.localTests&&this.attestationGate){
      if(!contextBinding||typeof contextBinding.conversation_state_ref!=='string'||!Number.isInteger(contextBinding.revision)||contextBinding.revision<1||typeof contextBinding.latest_event_ref!=='string'||!Array.isArray(contextBinding.consumed_state_keys)||!contextBinding.consumed_state_keys.length)
        throw new ControlError('PROJECT_BINDING_REQUIRED','Exact current Project conversation state and consumed state keys required',409);
      if(typeof this.contextVerifier!=='function'||(await this.contextVerifier(contextBinding))?.current!==true)
        throw new ControlError('STALE_PROJECT_BINDING','Project context requires independent current-state verification',409);
    }
    if(!allowedUrl(startUrl,{localTests:this.localTests}))throw new ControlError('ORIGIN_BLOCKED','New task must start on an approved Xero page',403);
    if(!this.browser.createTab||!this.browser.closeTab)throw new ControlError('TAB_LIFECYCLE_UNAVAILABLE','CDP driver must support owned create/close');
    if(this.openKeys.has(digest))throw new ControlError('TASK_ALREADY_RESERVED','Task opening already in progress',409);
    this.openKeys.add(digest);
    try{
      const hostReceipt=await this.assertAuthorizedWrite();
      const lease=await this.taskRegistry.reserve(digest);
      let created;
      try{
        created=await this.browser.createTab(startUrl);
        if(!created?.id||typeof created.id!=='string'||created.id.length>120)throw new ControlError('TAB_CREATION_UNCERTAIN','Chrome returned no target identity',502);
        await this.taskRegistry.transition(lease.taskId,'CREATED',{tabId:created.id});
      }catch(e){await this.taskRegistry.transition(lease.taskId,'UNCERTAIN',{tabId:created?.id||null});throw e;}
      const task={taskId:lease.taskId,tabId:created.id,digest,scope:exact,state:'CREATED',sessionId:null,anchors:null,
        identityChecks:0,mutationCounter:0,persistedCounter:null,createdByPlugin:true,startUrl,preparedActions:0,provisional:exact.returnRef==='PENDING_RETURN',contextBinding,coveragePlan:null,openingHostAttested:hostReceipt.attested===true,hostFingerprint:hostReceipt.fingerprint??null};
      this.managedTasks.set(lease.taskId,task);this.tabOwners.set(created.id,lease.taskId);
      return {taskId:lease.taskId,tabId:created.id,state:'TAB_CREATED_PENDING_BIND',scopeDigest:digest,
        requiredNext:'Navigate to exact Xero return, then bind client/FY/form/organization evidence'};
    }finally{this.openKeys.delete(digest);}
  }
  async taskCreateReturn({taskId,idempotencyKey,action,verifiedObligationRef,duplicateSearchRef}){
    const t=await this.requireOwnedTask(taskId,['CREATED']);
    if(!t.provisional)throw new ControlError('RETURN_ALREADY_IDENTIFIED','Only provisional tasks can create a new return',409);
    if([verifiedObligationRef,duplicateSearchRef].some(x=>typeof x!=='string'||!/^[a-zA-Z0-9_.:-]{10,160}$/.test(x)))
      throw new ControlError('RETURN_PREFLIGHT_REQUIRED','Verified obligation and current duplicate search references required',409);
    if(!this.localTests&&this.attestationGate){if(typeof this.obligationVerifier!=='function'||(await this.obligationVerifier({scope:t.scope,verifiedObligationRef,duplicateSearchRef}))?.verified!==true)
      throw new ControlError('RETURN_PREFLIGHT_UNVERIFIED','A separate Xero Tax obligation/duplicate check is required',409);}
    checkKey(idempotencyKey);const a=validateAction(action);
    if(a.kind!=='click'||!a.selector||a.x!==undefined)throw new ControlError('RETURN_CREATION_ACTION_INVALID','Explicit selected Create Draft button required',403);
    const fingerprint=sha256(JSON.stringify({taskId,kind:'create_return',action:a,verifiedObligationRef,duplicateSearchRef}));
    const cached=await this.actionLedger.get(idempotencyKey);
    if(cached){if(cached.fingerprint!==fingerprint)throw new ControlError('IDEMPOTENCY_CONFLICT','Creation key reused',409);return {...cached.result,deduplicated:true};}
    await this.assertAuthorizedWrite();
    if(this.currentLocks.has(t.tabId))throw new ControlError('TAB_BUSY','Tab already controlled',409);
    this.currentLocks.add(t.tabId);
    try{const result=await this.driver(t.tabId,async d=>{
      const target=await d.describeTarget(a);riskGuard(a,target);
      if(!/\bcreate\b.*\b(draft|return|statement|bas|ias)\b/i.test(String(target.label||''))||target.tag!=='BUTTON')
        throw new ControlError('RETURN_CREATION_ACTION_INVALID','Button must be explicitly identified as create draft/return',403);
      await this.actionLedger.reserve(idempotencyKey,fingerprint,'create_return');
      await d.perform(a,target);const snap=await d.observe();
      if(!allowedUrl(snap.url,{localTests:this.localTests}))throw new ControlError('ORIGIN_DRIFT','Return creation left permitted Xero',409);
      return {status:'RETURN_CREATION_REQUESTED_ID_NOT_YET_BOUND',taskId,poststate_verified:false,action_id:idempotencyKey};
    });
    await this.actionLedger.commit(idempotencyKey,fingerprint,result);t.preparedActions++;
    return result;
    }catch(e){await this.markTaskDirty(t,'RETURN_CREATION_UNCERTAIN');throw e;}finally{this.currentLocks.delete(t.tabId);}
  }
  async taskPromoteReturn({taskId,returnRef}){
    const t=await this.requireOwnedTask(taskId,['CREATED']);
    if(!t.provisional)throw new ControlError('RETURN_ALREADY_IDENTIFIED','Not a provisional return task',409);
    const scope=normalizedTaskScope({...t.scope,returnRef});
    const snap=await this.browser.observe(t.tabId);
    if(!allowedUrl(snap.url,{localTests:this.localTests})||!new URL(snap.url).pathname.includes(returnRef))
      throw new ControlError('RETURN_REF_UNPROVEN','New Xero Return ID must be independently observable in actual route',409);
    const newDigest=taskDigest(scope);
    await this.taskRegistry.promote(taskId,newDigest);
    t.scope=scope;t.digest=newDigest;t.provisional=false;
    return {taskId,state:'EXACT_RETURN_IDENTIFIED_PENDING_FIRST_BIND',scopeDigest:newDigest};
  }
  async taskNavigate({taskId,url,idempotencyKey}){
    return this.taskPrepare({taskId,idempotencyKey,action:{kind:'navigate',url}});
  }
  async taskPrepare({taskId,idempotencyKey,action}){
    checkKey(idempotencyKey);
    const t=await this.requireOwnedTask(taskId,['CREATED']);
    const a=validateAction(action);
    if(!['navigate','click','scroll','wait'].includes(a.kind))throw new ControlError('TASK_PREPARE_READ_ONLY','Pre-bind preparation allows navigation only',403);
    if(a.kind==='navigate'&&!allowedUrl(a.url,{localTests:this.localTests}))throw new ControlError('ORIGIN_BLOCKED','Only approved Xero URLs allowed',403);
    const fingerprint=sha256(JSON.stringify({type:'task_prepare',taskId,tabId:t.tabId,action:a}));
    const prior=await this.actionLedger.get(idempotencyKey);
    if(prior){if(prior.fingerprint!==fingerprint)throw new ControlError('IDEMPOTENCY_CONFLICT','Preparation idempotency key reused',409);return {...prior.result,deduplicated:true};}
    await this.assertAuthorizedWrite();
    if(this.currentLocks.has(t.tabId)||this.currentKeys.has(idempotencyKey))throw new ControlError('TAB_BUSY','Task tab already being prepared',409);
    this.currentLocks.add(t.tabId);this.currentKeys.add(idempotencyKey);
    try{
      const r=await this.driver(t.tabId,async d=>{
        const target=a.kind==='click'?await d.describeTarget(a):{};
        if(a.kind==='click'&&(!(target.tag==='A'||target.role==='link')||!allowedUrl(target.href,{localTests:this.localTests})))
          throw new ControlError('TASK_PREPARE_READ_ONLY','Pre-bind click must be a verified Xero navigation link, not a button or form mutation',403);
        riskGuard(a,target);
        await this.actionLedger.reserve(idempotencyKey,fingerprint,'task_prepare');
        if(a.kind==='wait')await sleep(a.ms);else await d.perform(a,target);
        const observation=await retryRead(()=>d.observe());
        if(!allowedUrl(observation.url,{localTests:this.localTests}))throw new ControlError('ORIGIN_DRIFT','Pre-bind task moved outside Xero',403);
        return {status:'PREPARING_NOT_YET_IDENTITY_BOUND',action_kind:a.kind,action_id:idempotencyKey,taskId,
          tabId:t.tabId,observation_returned:true,poststate_verified:false};
      });
      await this.actionLedger.commit(idempotencyKey,fingerprint,r);t.preparedActions++;return r;
    }catch(e){if(!['TASK_PREPARE_READ_ONLY','IRREVERSIBLE_BLOCKED','ORIGIN_BLOCKED'].includes(e.code))await this.markTaskDirty(t,'PREPARE_ACTION_UNCERTAIN');throw e;}
    finally{this.currentLocks.delete(t.tabId);this.currentKeys.delete(idempotencyKey);}
  }
  async requireOwnedTask(taskId,states=null){
    const r=await this.taskRegistry.get(taskId),t=this.managedTasks.get(taskId);
    if(!r||!t||!r.createdByPlugin||r.tabId!==t.tabId||r.scopeDigest!==t.digest||this.tabOwners.get(t.tabId)!==taskId)
      throw new ControlError('TASK_RECONCILIATION_REQUIRED','Task ownership must be independently restored; cannot borrow a tab',409);
    if(typeof this.taskRegistry.assertLease==='function')await this.taskRegistry.assertLease(taskId);
    if(states&&!states.includes(t.state))throw new ControlError('TASK_WRONG_STATE',`Task is ${t.state}; cannot use this operation`,409);
    return t;
  }
  async assertTaskTabAvailable(t){
    const tabs=await retryRead(()=>this.browser.tabs());
    const tab=tabs.find(x=>x.id===t.tabId);
    if(!tab||!allowedUrl(tab.url,{localTests:this.localTests})){
      await this.markTaskDirty(t,'TAB_MISSING_OR_FOREIGN');throw new ControlError('TASK_TAB_CHANGED','Bound Chrome target missing or navigated outside Xero',409);
    }
    return tab;
  }
  ensureTaskAnchors(t,anchors,snap){
    const a=normalizeIdentityAnchors(anchors);
    if(!a.year.includes(t.scope.fy.slice(-4)))throw new ControlError('TASK_YEAR_CONFLICT','Provided year evidence does not match declared FY',409);
    const forms={ITR:/individual|itr/i,CTR:/company|ctr/i,TRT:/trust|trt/i,PTR:/partnership|ptr/i,
      SMSF:/smsf|self.managed|superannuation/i,FBT:/fbt|fringe/i,BAS:/bas|business activity/i,
      IAS:/ias|instalment/i,ANNUAL_BAS:/bas|annual activity/i,ACCOUNTING:/accounting|ledger|bookkeep/i,PAYROLL:/payroll|pay run/i};
    if(!forms[t.scope.formType].test(a.form))throw new ControlError('TASK_FORM_CONFLICT','Form evidence does not match selected tax form kind',409);
    if(!a.organization||a.organization.toLocaleLowerCase()!==t.scope.xeroOrgLabel.toLocaleLowerCase())throw new ControlError('TASK_ORG_CONFLICT','Xero organization label must match the authoritative task binding',409);
    if(a.client.toLocaleLowerCase()!==t.scope.entity.toLocaleLowerCase())throw new ControlError('TASK_CLIENT_CONFLICT','Visible client anchor does not match exact selected legal entity',409);
    const u=new URL(snap.url);
    if(!u.pathname.includes(t.scope.returnRef)&&!u.search.includes(t.scope.returnRef)&&a.returnRef!==t.scope.returnRef)
      throw new ControlError('TASK_RETURN_REF_UNPROVEN','Unique Xero return ID must be visible or present in actual URL',409);
    this.checkSnapshot(snap,Object.values(a));assertTaskIdentity(snap,t.scope,a);
    return a;
  }
  async captureTaskProbe(t){
    const p=typeof this.browser.lightweightProbe==='function'?await this.browser.lightweightProbe(t.tabId):null;
    if(p&&!allowedUrl(p.url,{localTests:this.localTests}))throw new ControlError('TASK_ORIGIN_DRIFT','Probe detected foreign origin',409);
    t.lastProbe=p||{url:t.boundUrl,documentToken:null};return t.lastProbe;
  }
  async taskBind({taskId,anchors,formGuard}){
    const t=await this.requireOwnedTask(taskId,['CREATED']);
    await this.assertTaskTabAvailable(t);
    const snap=await retryRead(()=>this.browser.observe(t.tabId));
    const a=this.ensureTaskAnchors(t,anchors,snap);
    if(typeof this.browser.installIdentityGuard==='function')await this.browser.installIdentityGuard(t.tabId,Object.values(a),formGuard);
    else if(!this.localTests)throw new ControlError('TASK_GUARD_UNAVAILABLE','Production requires event-driven browser identity watcher',409);
    const probe=await this.captureTaskProbe(t);
    const sessionId=randomUUID();
    const s={tabId:t.tabId,scope:Object.freeze({project:t.scope.project,entity:t.scope.entity,period:t.scope.period,matter:t.scope.matter}),
      anchors:Object.values(a),expiresAt:this.now()+this.sessionTtlMs,managedTaskId:taskId,boundUrl:snap.url,boundProbe:probe};
    await this.taskRegistry.transition(taskId,'BOUND');
    t.anchors=a;t.formGuard=formGuard||null;t.sessionId=sessionId;t.state='BOUND';t.identityChecks++;
    this.sessions.set(sessionId,s);
    return {...this.present(sessionId,snap),taskId,scope:t.scope,state:'BOUND',identityCheck:'INITIAL_ONLY',
      nextFullIdentityCheck:'FINAL_OR_EXCEPTION'};
  }
  async markTaskDirty(t,reason){
    if(!t||t.state==='CLOSED'||t.state==='VERIFIED')return;
    t.state='NEEDS_REVALIDATION';t.persistedCounter=null;
    if(t.sessionId){const s=this.sessions.get(t.sessionId);if(s)s.invalidated=true;}
    try{await this.taskRegistry.transition(t.taskId,'NEEDS_REVALIDATION');}catch(e){throw new ControlError('TASK_JOURNAL_WRITE_FAILED','Task revalidation state could not be persisted: '+String(e.code||'IO_ERROR'),503);}
    t.lastReason=reason;
  }
  async taskPause({taskId,reason='USER_PAUSE'}){
    const t=await this.requireOwnedTask(taskId,['CREATED','BOUND','NEEDS_REVALIDATION']);
    if(this.currentLocks.has(t.tabId))throw new ControlError('TAB_BUSY','Cannot pause while a write is in progress',409);
    t.state='PAUSED';t.lastReason=String(reason).slice(0,100);
    if(t.sessionId){const s=this.sessions.get(t.sessionId);if(s)s.invalidated=true;}
    await this.taskRegistry.transition(taskId,'PAUSED');
    return {taskId,state:'PAUSED',tabId:t.tabId,next:'Explicit resume requires fresh complete client/FY/form identity check'};
  }
  async taskResume({taskId,anchors,formGuard}){
    const hostReceipt=await this.assertAuthorizedWrite();
    const t=await this.requireOwnedTask(taskId,['PAUSED','NEEDS_REVALIDATION']);
    if(!this.localTests&&this.attestationGate&&(!this.contextVerifier||(await this.contextVerifier(t.contextBinding))?.current!==true))
      throw new ControlError('STALE_PROJECT_BINDING','Resume requires fresh original Project/workpaper binding',409);
    await this.assertTaskTabAvailable(t);
    const snap=await retryRead(()=>this.browser.observe(t.tabId));
    const a=this.ensureTaskAnchors(t,anchors||t.anchors,snap);
    if(typeof this.browser.installIdentityGuard==='function')await this.browser.installIdentityGuard(t.tabId,Object.values(a),formGuard||t.formGuard);
    else if(!this.localTests)throw new ControlError('TASK_GUARD_UNAVAILABLE','Production requires an installed identity watcher',409);
    const probe=await this.captureTaskProbe(t);
    if(t.sessionId)this.sessions.delete(t.sessionId);
    const sessionId=randomUUID();
    const s={tabId:t.tabId,scope:{project:t.scope.project,entity:t.scope.entity,period:t.scope.period,matter:t.scope.matter},
      anchors:Object.values(a),expiresAt:this.now()+this.sessionTtlMs,managedTaskId:taskId,boundUrl:snap.url,boundProbe:probe};
    await this.taskRegistry.transition(taskId,'BOUND');
    t.state='BOUND';t.sessionId=sessionId;t.anchors=a;t.formGuard=formGuard||t.formGuard||null;t.identityChecks++;t.persistedCounter=null;t.openingHostAttested=hostReceipt.attested===true;t.hostFingerprint=hostReceipt.fingerprint??null;
    this.sessions.set(sessionId,s);
    return {...this.present(sessionId,snap),taskId,state:'RESUMED_AFTER_REVALIDATION',identityCheck:'EXCEPTION_ONLY'};
  }
  async taskRecover({taskId,scope,anchors,formGuard}){
    // Restart recovery: no automatic adoption. Exact previously journaled task ID, scope hash and TAB ID required.
    const old=await this.taskRegistry.get(taskId),exact=normalizedTaskScope(scope);
    if(!old||!old.createdByPlugin||!old.tabId||old.scopeDigest!==taskDigest(exact)||old.state==='CLOSED')
      throw new ControlError('TASK_RECOVERY_BLOCKED','Recovery requires an exact journaled task, identity and owned tab',409);
    if(this.managedTasks.has(taskId))throw new ControlError('TASK_ALREADY_ATTACHED','Use resume on the existing runtime task',409);
    if([...this.managedTasks.values()].some(t=>t.tabId===old.tabId)||this.tabOwners.has(old.tabId))throw new ControlError('TASK_TAB_CONFLICT','Another task already owns this tab',409);
    const t={taskId,tabId:old.tabId,digest:old.scopeDigest,scope:exact,state:'NEEDS_REVALIDATION',sessionId:null,
      anchors:null,identityChecks:0,mutationCounter:0,persistedCounter:null,coveragePlan:null,contextBinding:null,createdByPlugin:true};
    this.managedTasks.set(taskId,t);this.tabOwners.set(t.tabId,taskId);
    try{return await this.taskResume({taskId,anchors,formGuard});}
    catch(e){this.managedTasks.delete(taskId);this.tabOwners.delete(t.tabId);throw e;}
  }
  async assertManagedStable(s,d){
    if(!s.managedTaskId)return true;
    const t=await this.requireOwnedTask(s.managedTaskId,['BOUND']);
    if(!this.localTests&&this.attestationGate){
      if(typeof this.contextVerifier!=='function')throw new ControlError('CONTEXT_VERIFIER_UNAVAILABLE','Metadata verifier unavailable',503);
      if((await this.contextVerifier(t.contextBinding))?.current!==true){await this.markTaskDirty(t,'PROJECT_REVISION_CHANGED');throw new ControlError('STALE_PROJECT_BINDING','Project state updated; rebase before next field batch',409);}
    }
    if(!this.localTests&&this.attestationGate){
      if(typeof this.writerLeaseVerifier!=='function'||(await this.writerLeaseVerifier({taskId:t.taskId}))?.exclusive!==true)
        throw new ControlError('WRITER_BROKER_UNAVAILABLE','Exclusive Chrome writer lease cannot be verified on the current batch',409);
    }
    if(s.invalidated)throw new ControlError('TASK_REVALIDATION_REQUIRED','Task is paused or has changed; resume and verify identity',409);
    const probe=typeof d.lightweightProbe==='function'?await d.lightweightProbe():
      (typeof this.browser.lightweightProbe==='function'?await this.browser.lightweightProbe(s.tabId):null);
    if(!probe){return true;} // Synthetic drivers without a probe still use their exact owned tab object.
    if(!allowedUrl(probe.url,{localTests:this.localTests})||!s.boundProbe?.url)throw new ControlError('TASK_ROUTE_DRIFT','Task origin could not be established',409);
    if(probe.guardDirty===true||(s.boundProbe.guardInstalled===true&&probe.guardInstalled!==true)){
      await this.markTaskDirty(t,'CLIENT_OR_FORM_DOM_REPLACED');throw new ControlError('TASK_REVALIDATION_REQUIRED','Identity watcher detected external page replacement',409);
    }
    const prev=new URL(s.boundProbe.url),current=new URL(probe.url);
    const sameResource=s.boundProbe.url===probe.url ||
       (current.origin===prev.origin && s.boundProbe.url.includes(t.scope.returnRef) && probe.url.includes(t.scope.returnRef));
    if(!sameResource||current.origin!==prev.origin||
      (s.boundProbe.documentToken!==null&&s.boundProbe.documentToken!==undefined&&probe.documentToken!==s.boundProbe.documentToken)){
      await this.markTaskDirty(t,'TAB_NAVIGATION_OR_DOCUMENT_REPLACED');
      throw new ControlError('TASK_REVALIDATION_REQUIRED','Tab route or document changed; check identity only at exception',409);
    }
    return true;
  }
  assertFieldStillSameTask(s,field){
    if(!s.managedTaskId||!field?.url)return;
    const old=s.boundProbe;
    if(field.guardDirty===true||(old?.guardInstalled===true&&field.guardInstalled!==true))throw new ControlError('TASK_REVALIDATION_REQUIRED','Identity watcher detected page change during input',409);
    if(!old||!allowedUrl(field.url,{localTests:this.localTests})||
      (old.documentToken!=null&&field.documentToken!==old.documentToken)||
      (field.url!==old.url&&!field.url.includes(this.managedTasks.get(s.managedTaskId)?.scope.returnRef||'NO_SUCH_RETURN')))
      throw new ControlError('TASK_REVALIDATION_REQUIRED','Form changed during batch entry',409);
  }
  async taskPlan({taskId,sections,workpaperVersion}){
    const t=await this.requireOwnedTask(taskId,['BOUND']);
    if(t.coveragePlan||await this.taskRegistry.getCoverage(taskId))throw new ControlError('COVERAGE_ALREADY_FROZEN','Cannot replace an active return coverage plan',409);
    if(!Array.isArray(sections)||sections.length<2||sections.length>120||sections.some(x=>typeof x!=='string'||!/^[a-zA-Z0-9_.-]{3,80}$/.test(x))||new Set(sections).size!==sections.length)
      throw new ControlError('COVERAGE_PLAN_REQUIRED','Freeze at least two unique non-sensitive return section IDs',409);
    if(typeof workpaperVersion!=='string'||!/^[a-zA-Z0-9_.:-]{10,160}$/.test(workpaperVersion))throw new ControlError('WORKPAPER_VERSION_REQUIRED','Exact versioned source workpaper reference required',409);
    const plan={sections:[...sections],planDigest:sha256(JSON.stringify({resource:t.digest,sections,workpaperVersion})),verified:[]};
    await this.taskRegistry.recordCoverage(t.taskId,plan);t.coveragePlan=plan;
    return {taskId,planDigest:plan.planDigest,sections:sections.length,state:'COVERAGE_FROZEN'};
  }
  async taskCheckpoint({taskId,sectionId,verifyActionKey}){
    const t=await this.requireOwnedTask(taskId,['BOUND']);
    const plan=await this.taskRegistry.getCoverage(taskId);
    if(!plan||!plan.sections.includes(sectionId))throw new ControlError('SECTION_NOT_IN_PLAN','Unknown mandatory return section',409);
    checkKey(verifyActionKey);
    const receipt=await this.actionLedger.get(verifyActionKey);
    if(receipt?.result?.status!=='DRAFT_PERSISTENCE_VERIFIED'||receipt.result?.sessionTag!==sha256(t.sessionId)||t.persistedCounter!==t.mutationCounter)
      throw new ControlError('SECTION_SAVE_EVIDENCE_REQUIRED','Only persisted same-session Xero Save/reload evidence may close a section',409);
    const receiptHash=sha256(JSON.stringify({key:verifyActionKey,receipt:receipt.result,resource:t.digest}));
    if(plan.verified.some(x=>x.receiptHash===receiptHash&&x.sectionId!==sectionId))
      throw new ControlError('COVERAGE_REUSED_SAVE','One Save/reload proof cannot verify multiple distinct return sections',409);
    const verified=plan.verified.filter(x=>x.sectionId!==sectionId);
    verified.push({sectionId,receiptHash});
    const updated={...plan,verified};await this.taskRegistry.recordCoverage(taskId,updated);t.coveragePlan=updated;
    return {taskId,sectionId,state:'SECTION_PERSISTENCE_CHECKPOINTED',sectionsVerified:verified.length,sectionsRequired:plan.sections.length};
  }
  async taskReviewApprove({taskId,reviewReceipt}){
    const t=await this.requireOwnedTask(taskId,['REVIEW']);
    if(!this.localTests&&this.attestationGate){if(typeof this.contextVerifier!=='function'||(await this.contextVerifier(t.contextBinding))?.current!==true)
      throw new ControlError('STALE_PROJECT_BINDING','Review cannot approve a superseded Project workpaper revision',409);}
    if(!this.reviewPublicKey)throw new ControlError('INDEPENDENT_VERIFIER_UNAVAILABLE','Separate tax reviewer public key not installed',503);
    const cov=await this.taskRegistry.getCoverage(taskId);
    if(!cov||!reviewReceipt||reviewReceipt.taskDigest!==t.digest||reviewReceipt.planDigest!==cov.planDigest||reviewReceipt.coverageDigest!==sha256(JSON.stringify(cov.verified))||reviewReceipt.verdict!=='PASS'||reviewReceipt.verifier!=='XERO_TAX_DOMAIN_REVIEW')
      throw new ControlError('DOMAIN_REVIEW_INVALID','Signed independent tax review mismatches immutable task scope/coverage',409);
    const message=JSON.stringify({taskDigest:t.digest,planDigest:cov.planDigest,coverageDigest:reviewReceipt.coverageDigest,verdict:'PASS',verifier:'XERO_TAX_DOMAIN_REVIEW'});
    let valid=false;try{valid=verifySignature(null,Buffer.from(message),this.reviewPublicKey,Buffer.from(reviewReceipt.signature,'base64'));}catch{}
    if(!valid)throw new ControlError('DOMAIN_REVIEW_SIGNATURE_INVALID','Independent verifier signature failed',403);
    await this.taskRegistry.transition(taskId,'VERIFIED');t.state='VERIFIED';
    return {taskId,state:'DOMAIN_REVIEW_VERIFIED',tax_return_ready_for_human_review:true};
  }
  async taskFinish({taskId,expectedFields,closeTab=true}){
    const t=await this.requireOwnedTask(taskId,['BOUND']);
    const s=this.getSession(t.sessionId);
    await this.assertAuthorizedWrite({sessionId:t.sessionId,force:true});
    if(t.persistedCounter===null||t.persistedCounter!==t.mutationCounter)
      throw new ControlError('TASK_UNSAVED_OR_UNVERIFIED','Finish requires verified Save/reload after the last field mutation',409);
    const coverage=await this.taskRegistry.getCoverage(taskId);
    if(!coverage||coverage.sections.length<2||coverage.sections.some(x=>!coverage.verified.some(r=>r.sectionId===x)))
      throw new ControlError('FULL_RETURN_COVERAGE_MISSING','All frozen return sections require persisted verification',409);
    if(closeTab)throw new ControlError('DOMAIN_REVIEW_REQUIRED','Final UI audit cannot automatically close a tax return before independent review',409);
    if(!Array.isArray(expectedFields)||!expectedFields.length||expectedFields.length>12||expectedFields.some(f=>typeof f.selector!=='string'||typeof f.text!=='string'))
      throw new ControlError('TASK_FINAL_FIELDS_REQUIRED','Final form audit requires 1-12 expected field values',409);
    if(this.currentLocks.has(t.tabId))throw new ControlError('TAB_BUSY','Cannot finish while a write is in progress',409);
    this.currentLocks.add(t.tabId);
    try{
      const snap=await retryRead(()=>this.browser.observe(t.tabId));
      this.ensureTaskAnchors(t,t.anchors,snap); // ONE full final client/FY/form/organization check
      for(const f of expectedFields){const actual=await this.browser.readField(t.tabId,f.selector);
        if(actual?.count!==1||actual?.value!==f.text)throw new ControlError('TASK_FINAL_FIELD_MISMATCH','Final field values do not match persisted expected data',409);
      }
      t.identityChecks++;await this.captureTaskProbe(t);t.state='REVIEW';await this.taskRegistry.transition(taskId,'REVIEW');
    }catch(e){await this.markTaskDirty(t,'FINAL_VERIFICATION_FAILED');throw e;}
    finally{this.currentLocks.delete(t.tabId);}
    return {taskId,scopeDigest:t.digest,formType:t.scope.formType,fy:t.scope.fy,
      state:'UI_AUDIT_COMPLETE_AWAITING_DOMAIN_REVIEW',final_identity_checked:true,persisted_sections:coverage.verified.length,full_return_ready:false,
      tab_closed:false,identity_checks:t.identityChecks};
  }
  async taskClose({taskId}){
    const t=await this.requireOwnedTask(taskId,['VERIFIED','CREATED']);
    if(t.state==='CREATED'&&(t.mutationCounter>0||t.preparedActions>0))throw new ControlError('TASK_UNSAVED','Prepared or modified unbound tabs require explicit safe recovery, not automatic closure',409);
    await this.assertAuthorizedWrite();
    if(this.currentLocks.has(t.tabId))throw new ControlError('TAB_BUSY','Cannot close tab during another operation',409);
    this.currentLocks.add(t.tabId);
    try{
      const current=await this.assertTaskTabAvailable(t);
      if(t.state==='CREATED'&&current.url!==t.startUrl)throw new ControlError('TASK_TAB_CHANGED','Unbound tab was externally navigated; cannot close another client view',409);
      if(t.state==='VERIFIED'&&typeof this.browser.lightweightProbe==='function'){
        const currentProbe=await this.browser.lightweightProbe(t.tabId);
        if(currentProbe.guardDirty||!t.lastProbe||currentProbe.url!==t.lastProbe.url||currentProbe.documentToken!==t.lastProbe.documentToken)
          throw new ControlError('TASK_TAB_CHANGED','Chrome target changed after final verification; closure withheld',409);
      }
      const receipt=await this.browser.closeTab(t.tabId);
      if(receipt?.closed!==true)throw new ControlError('TAB_CLOSE_UNCERTAIN','Chrome did not confirm tab closed',502);
      await this.taskRegistry.transition(taskId,'CLOSED');
      t.state='CLOSED';if(t.sessionId)this.sessions.delete(t.sessionId);
      this.tabOwners.delete(t.tabId);this.managedTasks.delete(taskId);
      return {taskId,tabId:t.tabId,closed:true,closed_only_owned_tab:true};
    }catch(e){await this.markTaskDirty(t,'CLOSE_UNCERTAIN');throw e;}
    finally{this.currentLocks.delete(t.tabId);}
  }
  async taskList(){const all=await this.taskRegistry.list();return all.map(t=>({taskId:t.taskId,tabId:t.tabId,
    state:this.managedTasks.get(t.taskId)?.state||'RECOVERY_REQUIRED',scopeDigest:t.scopeDigest,createdByPlugin:t.createdByPlugin}));}

 release({sessionId}){const s=this.sessions.get(sessionId);if(s?.managedTaskId)throw new ControlError('MANAGED_TASK_LIFECYCLE','Use taskPause/taskFinish/taskClose; do not release managed ownership',409);return{released:this.sessions.delete(sessionId)};}
}
