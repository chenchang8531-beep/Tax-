import {randomUUID} from 'node:crypto';
import {AtomicClaims,serialize} from './atomic-claims.mjs';
import {open, readFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {ControlError} from './safety.mjs';

// The ledger intentionally stores no browser form values, screenshots, or authentication material.
const safeResult = result => {
  const r={status:result.status,action_id:result.action_id,action_kind:result.action_kind,sessionTag:result.sessionTag,
    observation_returned:Boolean(result.observation_returned),poststate_verified:Boolean(result.poststate_verified),
    field_values_verified:Boolean(result.field_values_verified),
    fields:Array.isArray(result.fields)?result.fields.map(x=>({index:x.index,status:x.status,mode:x.mode||null})):undefined,
    after:result.after?{revision:result.after.revision}:undefined};
  return r;
};

export class MemoryActionLedger {
 constructor({now=Date.now}={}){this.records=new Map();this.now=now;}
 async get(key){return this.records.get(key);}
 async reserve(key,fingerprint,kind){
  const item={fingerprint,result:{status:'UNCERTAIN_OUTCOME',action_id:key,action_kind:kind},createdAt:this.now()};
  if(this.records.has(key))throw new ControlError('IDEMPOTENCY_CONFLICT','Idempotency key previously reserved',409);
  this.records.set(key,item);return item;
 }
 async commit(key,fingerprint,result){
   const prior=this.records.get(key);if(prior&&prior.fingerprint!==fingerprint)throw new ControlError('IDEMPOTENCY_CONFLICT','Idempotency payload changed',409);
   this.records.set(key,{fingerprint,result:safeResult(result),createdAt:prior?.createdAt??this.now()});
 }
 async prune(ttlMs=12*60*60*1000){for(const [k,v] of this.records)if(this.now()-v.createdAt>ttlMs)this.records.delete(k);}
}

export class DurableActionLedger extends MemoryActionLedger {
 constructor(path,{now=Date.now}={}){super({now});if(typeof path!=='string'||!path)throw new Error('Ledger path required');this.path=path;this.queue=Promise.resolve();this.operationQueue=Promise.resolve();this.claims=new AtomicClaims(path+'.claims');this.instanceId=randomUUID();this.ready=this.load();}
 async load(){
   let raw;try{raw=await readFile(this.path,'utf8');}catch(e){if(e.code==='ENOENT')return;throw e;}
   for(const line of raw.split('\n')){
    if(!line.trim())continue;
    let item;try{item=JSON.parse(line);}catch{throw new ControlError('LEDGER_CORRUPT','Durable ledger has an unreadable record',503);}
    if(item.v!==1||typeof item.key!=='string'||!/^[a-f0-9]{64}$/.test(item.fingerprint)||!['RESERVE','COMMIT'].includes(item.phase))throw new ControlError('LEDGER_CORRUPT','Durable ledger record invalid',503);
    this.records.set(item.key,{fingerprint:item.fingerprint,result:item.phase==='RESERVE'?{status:'UNCERTAIN_OUTCOME',action_id:item.key,action_kind:item.kind}:item.result,createdAt:item.createdAt});
   }
 }
 async append(item){
   await this.ready;
   // File appended and synchronized before returning control to any possible browser side effect.
   const payload=JSON.stringify(item)+'\n';
   const run=async()=>{await mkdir(dirname(this.path),{recursive:true});const f=await open(this.path,'a',0o600);try{await f.writeFile(payload);await f.sync();}finally{await f.close();}};
   const next=this.queue.then(run,run);this.queue=next;await next;
 }
 async get(key){await this.ready;return super.get(key);}
 async reserve(key,fingerprint,kind){await this.ready;return serialize(this,async()=>{
   if(this.records.has(key))throw new ControlError('IDEMPOTENCY_CONFLICT','Idempotency key previously reserved',409);
   // Atomic on-disk claim before async append or browser action, shared across processes.
   await this.claims.claim(key,this.instanceId);
   const createdAt=this.now();await this.append({v:1,phase:'RESERVE',key,fingerprint,kind,createdAt});
   this.records.set(key,{fingerprint,result:{status:'UNCERTAIN_OUTCOME',action_id:key,action_kind:kind},createdAt});
 });}
 async commit(key,fingerprint,result){await this.ready;return serialize(this,async()=>{
   const prev=this.records.get(key);if(!prev||prev.fingerprint!==fingerprint)throw new ControlError('IDEMPOTENCY_CONFLICT','Unreserved or changed operation',409);
   await this.claims.check(key,this.instanceId);
   const createdAt=prev.createdAt,sanitized=safeResult(result);
   await this.append({v:1,phase:'COMMIT',key,fingerprint,createdAt,result:sanitized});
   this.records.set(key,{fingerprint,result:sanitized,createdAt});
 });}
 async prune(){// Never expire persisted replay protection silently; compaction needs an independently managed retention/rotation plan.
 }
}
