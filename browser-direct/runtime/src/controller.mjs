import {randomUUID} from 'node:crypto';
import {ControlError,allowedUrl,requireExactScope,riskGuard,snapshotRevision,validateAction,sha256} from './safety.mjs';
import {MemoryActionLedger} from './ledger.mjs';
import {retryRead} from './retry.mjs';

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
 constructor(browser,{profileAttested=false,localTests=false,now=Date.now,sessionTtlMs=30*60*1000,ledger=new MemoryActionLedger({now})}={}){
  this.browser=browser;this.profileAttested=profileAttested;this.localTests=localTests;this.now=now;this.sessionTtlMs=sessionTtlMs;
  this.sessions=new Map();this.currentLocks=new Set();this.currentKeys=new Set();this.actionLedger=ledger;
 }
 async status(){
  let cdp_reachable=false,xero_tabs_count=0,cdp_error=null;
  try{const tabs=await this.tabs();cdp_reachable=true;xero_tabs_count=tabs.length;}catch(e){cdp_error=e.code||'CDP_NOT_AVAILABLE';}
  return {server:'initialized',cdp_target:'127.0.0.1:9222',cdp_reachable,xero_tabs_count,cdp_error,
   profile_attested:this.profileAttested,mode:'frontend_directed',scope:'Xero-only',backend_planner:false,tunnel_proven:false,
   bulk_fill_max_fields:MAX_FIELDS,write_retry_policy:'readback-before-fallback; no blind replay',wal_durable:this.actionLedger.constructor.name==='DurableActionLedger'};
 }
 async tabs(){const tabs=await retryRead(()=>this.browser.tabs());return tabs.filter(t=>allowedUrl(t.url,{localTests:this.localTests})).map(t=>({id:t.id,title:t.title,url:t.url}));}
 async bind({tabId,scope,anchors}){
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
  if(this.now()>s.expiresAt){this.sessions.delete(sessionId);throw new ControlError('SESSION_EXPIRED','Browser bind expired',409);}return s;}
 present(sessionId,snap){return {sessionId,revision:snapshotRevision(snap),tab:{id:this.getSession(sessionId).tabId,url:snap.url,title:snap.title},
    visibleText:snap.visibleText.slice(0,12000),controls:snap.controls.slice(0,150),viewport:snap.viewport,profileAttested:this.profileAttested};}
 async observe({sessionId,screenshot=false}){
  const s=this.getSession(sessionId);const snap=await retryRead(()=>this.browser.observe(s.tabId));this.checkSnapshot(snap,s.anchors);s.expiresAt=this.now()+this.sessionTtlMs;
  const result=this.present(sessionId,snap);
  if(screenshot)result.screenshot=await retryRead(()=>this.browser.screenshot(s.tabId));return result;
 }
 async driver(tabId,fn){
  if(typeof this.browser.transaction==='function')return this.browser.transaction(tabId,fn);
  return fn({observe:()=>this.browser.observe(tabId),describeTarget:a=>this.browser.describeTarget(tabId,a),
    perform:(a,el)=>this.browser.perform(tabId,a,el),
    readField:s=>this.browser.readField(tabId,s),setField:(f,mode)=>this.browser.setField(tabId,f,mode)});
 }
 async ensureNotBusy(s,key,fingerprint){
  const cached=await this.actionLedger.get(key);
  if(cached){if(cached.fingerprint!==fingerprint)throw new ControlError('IDEMPOTENCY_CONFLICT','Key already used for a different operation',409);
    return {...cached.result,deduplicated:true};}
  if(this.currentKeys.has(key)||this.currentLocks.has(s.tabId))throw new ControlError('TAB_BUSY','Action already running on tab or key',409);
  return null;
 }
 async act({sessionId,expectedRevision,action,idempotencyKey,expectedPoststate}){
  checkKey(idempotencyKey);checkRevision(expectedRevision);
  if(!this.profileAttested)throw new ControlError('PROFILE_NOT_ATTESTED','Chrome 9222 profile must be independently attested',403);
  const a=validateAction(action),predicate=validatePredicate(expectedPoststate);
  if(a.kind==='type'){
    const fill=await this.fillFields({sessionId,expectedRevision,idempotencyKey,fields:[{selector:a.selector,text:a.text}]});
    return {...fill,action_kind:'type',typed_value_verified:fill.field_values_verified,poststate_verified:false};
  }
  const fingerprint=sha256(JSON.stringify({type:'act',sessionId,expectedRevision,action:a,expectedPoststate:predicate}));
  const cached=await this.actionLedger.get(idempotencyKey);
  if(cached){if(cached.fingerprint!==fingerprint)throw new ControlError('IDEMPOTENCY_CONFLICT','Key already used for a different action',409);return {...cached.result,deduplicated:true};}
  const s=this.getSession(sessionId);
  if(this.currentLocks.has(s.tabId)||this.currentKeys.has(idempotencyKey))throw new ControlError('TAB_BUSY','Another action is in progress',409);
  this.currentLocks.add(s.tabId);this.currentKeys.add(idempotencyKey);
  try{
   const result=await this.driver(s.tabId,async d=>{
     const before=await retryRead(()=>d.observe());this.checkSnapshot(before,s.anchors);
     if(snapshotRevision(before)!==expectedRevision)throw new ControlError('STALE_PAGE','Page changed since observation; reobserve first',409);
     if(a.kind==='navigate'&&!allowedUrl(a.url,{localTests:this.localTests}))throw new ControlError('ORIGIN_BLOCKED','Only Xero origins allowed',403);
     const element=['click','double_click','hover','drag','type','press','select'].includes(a.kind)?await d.describeTarget(a):{};
     riskGuard(a,element);
     await this.actionLedger.reserve(idempotencyKey,fingerprint,a.kind);
     if(a.kind==='wait')await sleep(a.ms);else await d.perform(a,element);
     const after=await retryRead(()=>d.observe());let status='ACTION_OBSERVED_NO_ASSERTION';
     try{this.checkSnapshot(after,s.anchors);if(predicate)status=assertPoststate(after,predicate)?'POSTSTATE_VERIFIED':'POSTSTATE_MISMATCH';}
     catch{status='SCOPE_REVALIDATION_REQUIRED';}
     return {status,action_id:idempotencyKey,action_kind:a.kind,after:{revision:snapshotRevision(after),url:after.url,title:after.title},
       observation_returned:true,poststate_verified:status==='POSTSTATE_VERIFIED',deduplicated:false};
   });
   await this.actionLedger.commit(idempotencyKey,fingerprint,result);s.expiresAt=this.now()+this.sessionTtlMs;return result;
  }finally{this.currentKeys.delete(idempotencyKey);this.currentLocks.delete(s.tabId);await this.actionLedger.prune();}
 }
 async fillFields({sessionId,expectedRevision,idempotencyKey,fields}){
  checkKey(idempotencyKey);checkRevision(expectedRevision);
  if(!this.profileAttested)throw new ControlError('PROFILE_NOT_ATTESTED','Chrome 9222 profile must be independently attested',403);
  const requested=validateFields(fields);
  const fingerprint=sha256(JSON.stringify({type:'fill',sessionId,expectedRevision,fields:requested}));
  const cached=await this.actionLedger.get(idempotencyKey);
  if(cached){if(cached.fingerprint!==fingerprint)throw new ControlError('IDEMPOTENCY_CONFLICT','Key reused with different fields',409);return {...cached.result,deduplicated:true};}
  const s=this.getSession(sessionId);
  if(this.currentLocks.has(s.tabId)||this.currentKeys.has(idempotencyKey))throw new ControlError('TAB_BUSY','Another action is in progress',409);
  this.currentLocks.add(s.tabId);this.currentKeys.add(idempotencyKey);
  let reserved=false;
  try{
   const result=await this.driver(s.tabId,async d=>{
    const before=await retryRead(()=>d.observe());this.checkSnapshot(before,s.anchors);
    if(snapshotRevision(before)!==expectedRevision)throw new ControlError('STALE_PAGE','Page changed since observation; reobserve first',409);
    const reports=[];const finalAudit=[];let stopped=false;
    for(const f of requested){
      const current=await retryRead(()=>d.observe());
      try{this.checkSnapshot(current,s.anchors);}catch{reports.push({index:f.index,status:'SCOPE_REVALIDATION_REQUIRED'});stopped=true;break;}
      let selected=f.selector;let input=await retryRead(()=>d.readField(selected));
      if(input?.count===0&&f.fallbackSelector){
        selected=f.fallbackSelector;input=await retryRead(()=>d.readField(selected));
        if(!input||input.count!==1||!String(input.label||'').toLocaleLowerCase().includes(f.expectedLabel.toLocaleLowerCase())){reports.push({index:f.index,status:'FALLBACK_IDENTITY_MISMATCH'});stopped=true;break;}
      }
      if(!input||input.count!==1||!input.exists){reports.push({index:f.index,status:'AMBIGUOUS_FIELD'});stopped=true;break;}
      const target=await d.describeTarget({kind:'type',selector:selected});riskGuard({kind:'type',selector:selected},target);
      if(selected!==f.selector&&!String(target.label||'').toLocaleLowerCase().includes(f.expectedLabel.toLocaleLowerCase())){reports.push({index:f.index,status:'FALLBACK_IDENTITY_MISMATCH'});stopped=true;break;}
      const resolved={...f,selector:selected};
      if(!input.visible||!input.enabled||input.readOnly||!input.editable){reports.push({index:f.index,status:'FIELD_UNAVAILABLE'});stopped=true;break;}
      if(input.value===f.text){reports.push({index:f.index,status:'ALREADY_MATCHED'});finalAudit.push({index:f.index,selector:selected,text:f.text});continue;}
      if(!reserved){await this.actionLedger.reserve(idempotencyKey,fingerprint,'fill_fields');reserved=true;}
      await d.setField(resolved,'fast');
      let actual=await retryRead(()=>d.readField(selected));
      if(actual.count!==1||!actual.exists){reports.push({index:f.index,status:'TARGET_DRIFT_AFTER_INPUT'});stopped=true;break;}
      if(actual.value===f.text){reports.push({index:f.index,status:'VALUE_VERIFIED',mode:'fast'});finalAudit.push({index:f.index,selector:selected,text:f.text});continue;}
      // Fallback is allowed only if a real readback proves that fast entry made no change.
      if(actual.value===input.value){
        const afterInput=await retryRead(()=>d.observe());
        try{this.checkSnapshot(afterInput,s.anchors);}catch{reports.push({index:f.index,status:'SCOPE_REVALIDATION_REQUIRED'});stopped=true;break;}
        await d.setField(resolved,'keyed');actual=await retryRead(()=>d.readField(selected));
        if(actual.count===1&&actual.value===f.text){reports.push({index:f.index,status:'VALUE_VERIFIED',mode:'keyed'});finalAudit.push({index:f.index,selector:selected,text:f.text});continue;}
      }
      reports.push({index:f.index,status:'FIELD_MISMATCH_NO_RETRY'});stopped=true;break;
    }
    let after;
    try{after=await retryRead(()=>d.observe());this.checkSnapshot(after,s.anchors);}catch{stopped=true;}
    if(!stopped){for(const f of finalAudit){
      try{const final=await retryRead(()=>d.readField(f.selector));if(final?.count!==1||final.value!==f.text){reports.push({index:f.index,status:'FIELD_REVERTED_AFTER_BATCH'});stopped=true;break;}}
      catch{reports.push({index:f.index,status:'FINAL_AUDIT_UNAVAILABLE'});stopped=true;break;}
    }}
    const status=stopped?'PARTIAL_STOP':'FIELD_VALUES_VERIFIED_UNSAVED';
    return {status,action_id:idempotencyKey,action_kind:'fill_fields',fields:reports,
      field_values_verified:!stopped&&reports.length===requested.length,poststate_verified:false,
      observation_returned:Boolean(after),after:after?{revision:snapshotRevision(after)}:undefined,deduplicated:false};
   });
   await this.actionLedger.commit(idempotencyKey,fingerprint,result);s.expiresAt=this.now()+this.sessionTtlMs;return result;
  }finally{this.currentKeys.delete(idempotencyKey);this.currentLocks.delete(s.tabId);await this.actionLedger.prune();}
 }
 release({sessionId}){return{released:this.sessions.delete(sessionId)};}
}
