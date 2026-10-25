import {randomUUID} from 'node:crypto';
import {ControlError,allowedUrl,requireExactScope,riskGuard,snapshotRevision,validateAction,sha256} from './safety.mjs';
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
 constructor(browser,{profileAttested=false,attestationGate=null,localTests=false,now=Date.now,sessionTtlMs=30*60*1000,ledger=new MemoryActionLedger({now}),taskRegistry=new MemoryTaskRegistry(),requireManagedTasks=false}={}){
  this.browser=browser;this.profileAttested=profileAttested;this.attestationGate=attestationGate;this.localTests=localTests;this.now=now;this.sessionTtlMs=sessionTtlMs;
  this.sessions=new Map();this.currentLocks=new Set();this.currentKeys=new Set();this.actionLedger=ledger;
  this.taskRegistry=taskRegistry;this.requireManagedTasks=requireManagedTasks;this.managedTasks=new Map();this.tabOwners=new Map();this.openKeys=new Set();
 }
 async assertAuthorizedWrite({sessionId=null,force=false}={}){
  // OS owner/profile attestation is performed when the task OPENS and again at RESUME/FINAL.
  // During uninterrupted filling, the exact task-owned Chrome target and inexpensive document watcher guard continuity.
  if(sessionId&&!force){const bound=this.sessions.get(sessionId),task=bound?.managedTaskId&&this.managedTasks.get(bound.managedTaskId);
    if(task&&task.state==='BOUND'&&!bound.invalidated&&task.openingHostAttested===true)
      return {attested:true,reason:'UNCHANGED_TASK_LEASE; LIVE_TAB_GUARDED_SEPARATELY',fingerprint:task.hostFingerprint??null};
  }
  if(this.attestationGate)return this.attestationGate.assertAllowed();
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
     await this.actionLedger.reserve(idempotencyKey,fingerprint,a.kind);
     if(a.kind==='wait')await sleep(a.ms);else await d.perform(a,element);
     const after=await retryRead(()=>d.observe());let status='ACTION_OBSERVED_NO_ASSERTION';
     try{if(s.managedTaskId)await this.assertManagedStable(s,d);else this.checkSnapshot(after,s.anchors);if(predicate)status=assertPoststate(after,predicate)?'POSTSTATE_VERIFIED':'POSTSTATE_MISMATCH';}
     catch{status='SCOPE_REVALIDATION_REQUIRED';}
     return {status,action_id:idempotencyKey,action_kind:a.kind,sessionTag:sha256(sessionId),after:{revision:snapshotRevision(after),url:after.url,title:after.title},
       observation_returned:true,poststate_verified:status==='POSTSTATE_VERIFIED',deduplicated:false};
   });
   await this.actionLedger.commit(idempotencyKey,fingerprint,result);
   if(s.managedTaskId){const t=this.managedTasks.get(s.managedTaskId);if(t){t.mutationCounter++;t.persistedCounter=null;if(result.status==='SCOPE_REVALIDATION_REQUIRED')await this.markTaskDirty(t,'POST_ACTION_NAVIGATION_DRIFT');}}
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
    await d.reload();
    let after;
    try{after=await retryRead(()=>d.observe());this.checkSnapshot(after,s.anchors);}catch(e){
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
  async taskOpen({scope,startUrl}){
    const exact=normalizedTaskScope(scope),digest=taskDigest(exact);
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
        identityChecks:0,mutationCounter:0,persistedCounter:null,createdByPlugin:true,startUrl,preparedActions:0,openingHostAttested:hostReceipt.attested===true,hostFingerprint:hostReceipt.fingerprint??null};
      this.managedTasks.set(lease.taskId,task);this.tabOwners.set(created.id,lease.taskId);
      return {taskId:lease.taskId,tabId:created.id,state:'TAB_CREATED_PENDING_BIND',scopeDigest:digest,
        requiredNext:'Navigate to exact Xero return, then bind client/FY/form/organization evidence'};
    }finally{this.openKeys.delete(digest);}
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
  async taskBind({taskId,anchors}){
    const t=await this.requireOwnedTask(taskId,['CREATED']);
    await this.assertTaskTabAvailable(t);
    const snap=await retryRead(()=>this.browser.observe(t.tabId));
    const a=this.ensureTaskAnchors(t,anchors,snap);
    if(typeof this.browser.installIdentityGuard==='function')await this.browser.installIdentityGuard(t.tabId,Object.values(a));
    else if(!this.localTests)throw new ControlError('TASK_GUARD_UNAVAILABLE','Production requires event-driven browser identity watcher',409);
    const probe=await this.captureTaskProbe(t);
    const sessionId=randomUUID();
    const s={tabId:t.tabId,scope:Object.freeze({project:t.scope.project,entity:t.scope.entity,period:t.scope.period,matter:t.scope.matter}),
      anchors:Object.values(a),expiresAt:this.now()+this.sessionTtlMs,managedTaskId:taskId,boundUrl:snap.url,boundProbe:probe};
    await this.taskRegistry.transition(taskId,'BOUND');
    t.anchors=a;t.sessionId=sessionId;t.state='BOUND';t.identityChecks++;
    this.sessions.set(sessionId,s);
    return {...this.present(sessionId,snap),taskId,scope:t.scope,state:'BOUND',identityCheck:'INITIAL_ONLY',
      nextFullIdentityCheck:'FINAL_OR_EXCEPTION'};
  }
  async markTaskDirty(t,reason){
    if(!t||t.state==='CLOSED'||t.state==='VERIFIED')return;
    t.state='NEEDS_REVALIDATION';t.persistedCounter=null;
    if(t.sessionId){const s=this.sessions.get(t.sessionId);if(s)s.invalidated=true;}
    try{await this.taskRegistry.transition(t.taskId,'NEEDS_REVALIDATION');}catch{}
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
  async taskResume({taskId,anchors}){
    const hostReceipt=await this.assertAuthorizedWrite();
    const t=await this.requireOwnedTask(taskId,['PAUSED','NEEDS_REVALIDATION']);
    await this.assertTaskTabAvailable(t);
    const snap=await retryRead(()=>this.browser.observe(t.tabId));
    const a=this.ensureTaskAnchors(t,anchors||t.anchors,snap);
    if(typeof this.browser.installIdentityGuard==='function')await this.browser.installIdentityGuard(t.tabId,Object.values(a));
    else if(!this.localTests)throw new ControlError('TASK_GUARD_UNAVAILABLE','Production requires an installed identity watcher',409);
    const probe=await this.captureTaskProbe(t);
    if(t.sessionId)this.sessions.delete(t.sessionId);
    const sessionId=randomUUID();
    const s={tabId:t.tabId,scope:{project:t.scope.project,entity:t.scope.entity,period:t.scope.period,matter:t.scope.matter},
      anchors:Object.values(a),expiresAt:this.now()+this.sessionTtlMs,managedTaskId:taskId,boundUrl:snap.url,boundProbe:probe};
    await this.taskRegistry.transition(taskId,'BOUND');
    t.state='BOUND';t.sessionId=sessionId;t.anchors=a;t.identityChecks++;t.persistedCounter=null;t.openingHostAttested=hostReceipt.attested===true;t.hostFingerprint=hostReceipt.fingerprint??null;
    this.sessions.set(sessionId,s);
    return {...this.present(sessionId,snap),taskId,state:'RESUMED_AFTER_REVALIDATION',identityCheck:'EXCEPTION_ONLY'};
  }
  async taskRecover({taskId,scope,anchors}){
    // Restart recovery: no automatic adoption. Exact previously journaled task ID, scope hash and TAB ID required.
    const old=await this.taskRegistry.get(taskId),exact=normalizedTaskScope(scope);
    if(!old||!old.createdByPlugin||!old.tabId||old.scopeDigest!==taskDigest(exact)||old.state==='CLOSED')
      throw new ControlError('TASK_RECOVERY_BLOCKED','Recovery requires an exact journaled task, identity and owned tab',409);
    if(this.managedTasks.has(taskId))throw new ControlError('TASK_ALREADY_ATTACHED','Use resume on the existing runtime task',409);
    if([...this.managedTasks.values()].some(t=>t.tabId===old.tabId)||this.tabOwners.has(old.tabId))throw new ControlError('TASK_TAB_CONFLICT','Another task already owns this tab',409);
    const t={taskId,tabId:old.tabId,digest:old.scopeDigest,scope:exact,state:'NEEDS_REVALIDATION',sessionId:null,
      anchors:null,identityChecks:0,mutationCounter:0,persistedCounter:null,createdByPlugin:true};
    this.managedTasks.set(taskId,t);this.tabOwners.set(t.tabId,taskId);
    try{return await this.taskResume({taskId,anchors});}
    catch(e){this.managedTasks.delete(taskId);this.tabOwners.delete(t.tabId);throw e;}
  }
  async assertManagedStable(s,d){
    if(!s.managedTaskId)return true;
    const t=await this.requireOwnedTask(s.managedTaskId,['BOUND']);
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
  async taskFinish({taskId,expectedFields,closeTab=true}){
    await this.assertAuthorizedWrite();
    const t=await this.requireOwnedTask(taskId,['BOUND']);
    const s=this.getSession(t.sessionId);
    if(t.persistedCounter===null||t.persistedCounter!==t.mutationCounter)
      throw new ControlError('TASK_UNSAVED_OR_UNVERIFIED','Finish requires verified Save/reload after the last field mutation',409);
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
      t.identityChecks++;await this.captureTaskProbe(t);t.state='VERIFIED';await this.taskRegistry.transition(taskId,'VERIFIED');
    }catch(e){await this.markTaskDirty(t,'FINAL_VERIFICATION_FAILED');throw e;}
    finally{this.currentLocks.delete(t.tabId);}
    let closing=null;
    if(closeTab)closing=await this.taskClose({taskId});
    return {taskId,scopeDigest:t.digest,formType:t.scope.formType,fy:t.scope.fy,
      state:closing?.closed?'VERIFIED_AND_CLOSED':'VERIFIED',final_identity_checked:true,persisted:true,
      tab_closed:Boolean(closing?.closed),identity_checks:t.identityChecks};
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
