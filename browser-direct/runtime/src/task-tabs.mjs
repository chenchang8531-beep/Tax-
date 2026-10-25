import {randomUUID} from 'node:crypto';
import {open,readFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {AtomicClaims,serialize} from './atomic-claims.mjs';
import {ControlError,sha256,allowedUrl} from './safety.mjs';

// No client names, tax values, URLs, cookies or credentials are placed in the task journal.
const STATES=new Set(['RESERVED','CREATED','BOUND','PAUSED','NEEDS_REVALIDATION','VERIFIED','REVIEW','CLOSED','UNCERTAIN']);
const FORMS=new Set(['ITR','CTR','TRT','PTR','SMSF','FBT','BAS','IAS','ANNUAL_BAS','ACCOUNTING','PAYROLL']);
const FY=/^FY(20\d{2})$/;
const DATE_PERIOD=/^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/;
const TOKEN=/^[a-zA-Z0-9:!_./@-]{3,160}$/;
function exactString(v,name,max=160){if(typeof v!=='string'||v.trim().length<3||v.length>max)throw new ControlError('TASK_SCOPE_REQUIRED',`Exact ${name} required`,400);return v.trim();}
export function normalizedTaskScope(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new ControlError('TASK_SCOPE_REQUIRED','Exact task scope required');
 const keys=['project','clientRef','legalEntityRef','entity','entityType','fy','period','formType','matter','xeroOrgRef','xeroOrgLabel','returnRef'];
 if(Object.keys(input).some(k=>!keys.includes(k)))throw new ControlError('TASK_SCOPE_REQUIRED','Unknown task scope property',400);
 const s={};for(const k of keys)s[k]=exactString(input[k],k);
 if(!FY.test(s.fy)||!FORMS.has(s.formType))throw new ControlError('TASK_SCOPE_REQUIRED','Exact financial year and recognised form required');
 const year=Number(FY.exec(s.fy)[1]);
 if(FY.test(s.period)){
  if(s.period!==s.fy)throw new ControlError('TASK_PERIOD_CONFLICT','Return period conflicts with the selected financial year',409);
 }else{
  const match=DATE_PERIOD.exec(s.period);
  if(!match)throw new ControlError('TASK_SCOPE_REQUIRED','Exact FY or date-range period required');
  const validDate=raw=>{const dt=new Date(raw+'T00:00:00.000Z');return Number.isFinite(dt.getTime())&&dt.toISOString().slice(0,10)===raw?dt:null;};
  const start=validDate(match[1]),end=validDate(match[2]);
  if(!start||!end||start>end||start<new Date(Date.UTC(year-1,6,1))||end>new Date(Date.UTC(year,5,30)))
   throw new ControlError('TASK_PERIOD_CONFLICT','Period must fall inside the exact selected Australian financial year',409);
 }
 for(const k of ['clientRef','legalEntityRef','xeroOrgRef','returnRef'])if(!TOKEN.test(s[k]))throw new ControlError('TASK_SCOPE_REQUIRED',`A stable non-secret ${k} reference is required`);
 if(/(?:\b\d{9}\b|password|token|secret)/i.test([s.clientRef,s.legalEntityRef,s.xeroOrgRef,s.returnRef].join(' ')))throw new ControlError('TASK_SCOPE_REQUIRED','Never put TFNs or secrets in task references');
 return Object.freeze(s);
}
// Stable Xero resource identity excludes Project, client display aliases and narrative matter.
// A provisional return is locked by exact tenant + legal entity + FY/period/form until promotion.
export function taskDigest(scope){const s=normalizedTaskScope(scope);const identity=s.returnRef==='PENDING_RETURN'
 ?{tenant:s.xeroOrgRef,legalEntity:s.legalEntityRef,fy:s.fy,period:s.period,form:s.formType,provisional:true}
 :{tenant:s.xeroOrgRef,returnRef:s.returnRef};return sha256(JSON.stringify(identity));}
export function taskScopeDigest(scope){return sha256(JSON.stringify(normalizedTaskScope(scope)));}

export function normalizeIdentityAnchors(anchors){
 if(!anchors||typeof anchors!=='object'||Array.isArray(anchors)||Object.keys(anchors).some(k=>!['client','year','form','organization','returnRef'].includes(k)))throw new ControlError('TASK_ANCHORS_REQUIRED','Client, year and form evidence must be separate named anchors');
 const a={};for(const k of ['client','year','form'])a[k]=exactString(anchors[k],`identity ${k}`,200);
 for(const k of ['organization','returnRef'])if(anchors[k]!==undefined)a[k]=exactString(anchors[k],k,200);
 const v=Object.values(a).map(x=>x.toLowerCase());if(new Set(v).size!==v.length)throw new ControlError('TASK_ANCHORS_REQUIRED','Identity evidence must be independent');
 return Object.freeze(a);
}
export function assertTaskIdentity(snap,scope,anchors,{strictUrl=null}={}){
 if(!snap||!allowedUrl(snap.url,{localTests:true})||!Array.isArray(snap.controls)||typeof snap.visibleText!=='string')throw new ControlError('TASK_IDENTITY_UNKNOWN','Browser page evidence missing',409);
 if(strictUrl && snap.url!==strictUrl)throw new ControlError('TASK_URL_CHANGED','Return page URL changed; revalidate the task',409);
 const text=`${snap.title||''}\n${snap.visibleText}`.toLocaleLowerCase();
 const missing=Object.entries(anchors).filter(([,value])=>!text.includes(value.toLocaleLowerCase())).map(([name])=>name);
 if(missing.length)throw new ControlError('TASK_IDENTITY_MISMATCH',`Client/FY/form identity evidence missing: ${missing.join(',')}`,409);
 if(!scope||!scope.formType)throw new ControlError('TASK_SCOPE_REQUIRED','Scope must be bound');
 // This verifies visible evidence. A separate stable Xero formRef/organisationRef must originate from upstream mapping, not guessed DOM text.
 return {identity_verified:true,evidence_names:Object.keys(anchors),url:snap.url};
}
function recordTask(taskId,scopeDigest,state,tabId=null){return {taskId,scopeDigest,state,tabId,createdByPlugin:tabId!==null};}
export class MemoryTaskRegistry{
 constructor(){this.byId=new Map();this.keyOwners=new Map();this.recoveryRequired=false;this.coverage=new Map();}
 async reserve(scopeDigest){if(this.keyOwners.has(scopeDigest))throw new ControlError('TASK_ALREADY_RESERVED','Same client/FY/form/matter already has a task; resume it, do not open another tab',409);
  const taskId=randomUUID(),r=recordTask(taskId,scopeDigest,'RESERVED');this.byId.set(taskId,r);this.keyOwners.set(scopeDigest,taskId);return {...r};}
 async transition(taskId,state,{tabId=null}={}){
  if(!STATES.has(state))throw new ControlError('TASK_STATE_INVALID','Unknown task state');
  const r=this.byId.get(taskId);if(!r)throw new ControlError('TASK_UNKNOWN','Unknown task ID',404);
  if(state==='CREATED'&&(!tabId||r.state!=='RESERVED'))throw new ControlError('TASK_STATE_INVALID','Only a reserved task may claim a created tab',409);
  if(tabId&&r.tabId&&r.tabId!==tabId)throw new ControlError('TASK_TAB_CONFLICT','Task tab cannot be replaced',409);
  const next={...r,tabId:tabId||r.tabId,state,createdByPlugin:state==='CREATED'||r.createdByPlugin};
  this.byId.set(taskId,next);if(state==='CLOSED')this.keyOwners.delete(next.scopeDigest);return {...next};
 }
 async recordCoverage(id,plan){if(!this.byId.has(id))throw new ControlError('TASK_UNKNOWN','Unknown task',404);this.coverage.set(id,structuredClone(plan));return plan;}
 async getCoverage(id){return structuredClone(this.coverage.get(id)||null);}
 async promote(id,newDigest){const t=this.byId.get(id);if(!t||t.state!=='CREATED'||this.keyOwners.has(newDigest))throw new ControlError('RETURN_PROMOTION_CONFLICT','Resource already owned or not in provisional state',409);
   this.keyOwners.delete(t.scopeDigest);t.scopeDigest=newDigest;this.keyOwners.set(newDigest,id);return {...t};}
 async get(taskId){const r=this.byId.get(taskId);return r?{...r}:null;}
 async getByDigest(digest){const id=this.keyOwners.get(digest);return id?this.get(id):null;}
 async list(){return [...this.byId.values()].map(x=>({...x}));}
}
export class DurableTaskRegistry extends MemoryTaskRegistry{
 constructor(path){super();if(typeof path!=='string'||!path)throw new Error('TASK_LEDGER_PATH required');this.path=path;this.queue=Promise.resolve();this.operationQueue=Promise.resolve();this.claims=new AtomicClaims(path+'.claims');this.ready=this.load();}
 async load(){let source;try{source=await readFile(this.path,'utf8');}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const line of source.split('\n')){if(!line.trim())continue;let r;try{r=JSON.parse(line);}catch{throw new ControlError('TASK_LEDGER_CORRUPT','Task journal cannot be parsed',503);}
   if(r.v!==1||!r.taskId||!r.scopeDigest||!/^[a-f0-9]{64}$/.test(r.scopeDigest)||!STATES.has(r.state))throw new ControlError('TASK_LEDGER_CORRUPT','Task journal invalid',503);
   const previous=this.byId.get(r.taskId);if(previous?.tabId&&r.tabId&&previous.tabId!==r.tabId)throw new ControlError('TASK_LEDGER_CORRUPT','Task ID mapped to multiple tabs',503);
   if(previous?.scopeDigest!==r.scopeDigest&&previous?.scopeDigest)this.keyOwners.delete(previous.scopeDigest);
   if(r.state==='RESERVED'&&this.keyOwners.has(r.scopeDigest))throw new ControlError('TASK_LEDGER_CONFLICT','Two unfinished tasks share one identity scope',503);
   this.byId.set(r.taskId,recordTask(r.taskId,r.scopeDigest,r.state,r.tabId||previous?.tabId||null));
   if(r.coverage){if(!Array.isArray(r.coverage.sections)||r.coverage.sections.length>120||typeof r.coverage.planDigest!=='string')throw new ControlError('TASK_LEDGER_CORRUPT','Coverage journal invalid',503);this.coverage.set(r.taskId,r.coverage);}
   if(r.state==='CLOSED')this.keyOwners.delete(r.scopeDigest);else this.keyOwners.set(r.scopeDigest,r.taskId);
  }
  // A restart cannot silently recover a previous lease, even if the tab is still present.
  this.recoveryRequired=[...this.byId.values()].some(r=>r.state!=='CLOSED');
 }
 async append(row){await this.ready;const write=async()=>{await mkdir(dirname(this.path),{recursive:true});const f=await open(this.path,'a',0o600);try{await f.writeFile(JSON.stringify({v:1,...row})+'\n');await f.sync();}finally{await f.close();}};const p=this.queue.then(write,write);this.queue=p;await p;}
 async reserve(digest){await this.ready;return serialize(this,async()=>{
  if(this.keyOwners.has(digest))throw new ControlError('TASK_ALREADY_RESERVED','Unfinished task already exists',409);
  const id=randomUUID();await this.claims.claim(digest,id);
  await this.append({taskId:id,scopeDigest:digest,state:'RESERVED',tabId:null});
  const r=recordTask(id,digest,'RESERVED');this.byId.set(id,r);this.keyOwners.set(digest,id);return {...r};
 });}
 async recordCoverage(id,plan){await this.ready;return serialize(this,async()=>{
   const t=this.byId.get(id);if(!t||t.state==='CLOSED')throw new ControlError('TASK_UNKNOWN','Unknown active task',409);
   await this.claims.check(t.scopeDigest,id);
   if(!plan||typeof plan.planDigest!=='string'||!Array.isArray(plan.sections)||plan.sections.length<2||plan.sections.length>120)throw new ControlError('COVERAGE_INVALID','Invalid full-return coverage evidence',409);
   await this.append({taskId:id,scopeDigest:t.scopeDigest,state:t.state,tabId:t.tabId,coverage:plan});
   this.coverage.set(id,structuredClone(plan));return structuredClone(plan);
 });}
 async getCoverage(id){await this.ready;return structuredClone(this.coverage.get(id)||null);}
 async promote(id,newDigest){await this.ready;return serialize(this,async()=>{
   const old=this.byId.get(id);
   if(!old||old.state!=='CREATED'||this.keyOwners.has(newDigest))throw new ControlError('RETURN_PROMOTION_CONFLICT','Provisional task not available or exact return already owned',409);
   const oldDigest=old.scopeDigest;
   await this.claims.check(oldDigest,id);
   await this.claims.claim(newDigest,id);
   await this.append({taskId:id,scopeDigest:newDigest,state:'CREATED',tabId:old.tabId});
   const result=await super.promote(id,newDigest);
   await this.claims.release(oldDigest,id);
   return result;
 });}
 async assertLease(id){await this.ready;const r=this.byId.get(id);if(!r||r.state==='CLOSED')throw new ControlError('TASK_LEASE_UNAVAILABLE','No active task lease',409);
   await this.claims.check(r.scopeDigest,id);return true;}
 async transition(id,state,{tabId=null}={}){await this.ready;return serialize(this,async()=>{
  const old=this.byId.get(id);if(!old)throw new ControlError('TASK_UNKNOWN','Unknown task ID',404);
  if(!STATES.has(state)||state==='CREATED'&&(!tabId||old.state!=='RESERVED'))throw new ControlError('TASK_STATE_INVALID','Invalid task transition',409);
  if(tabId&&old.tabId&&old.tabId!==tabId)throw new ControlError('TASK_TAB_CONFLICT','Cannot replace owned tab',409);
  await this.assertLease(id);
  await this.append({taskId:id,scopeDigest:old.scopeDigest,state,tabId:tabId||old.tabId});
  const result=await super.transition(id,state,{tabId});
  if(state==='CLOSED')await this.claims.release(old.scopeDigest,id);
  return result;
 });}
 async get(id){await this.ready;return super.get(id);}
 async getByDigest(digest){await this.ready;return super.getByDigest(digest);}
 async list(){await this.ready;return super.list();}
}
