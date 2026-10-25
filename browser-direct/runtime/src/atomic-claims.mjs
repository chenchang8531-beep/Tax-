import {mkdir,open,readFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {ControlError,sha256} from './safety.mjs';

// mkdir is the single-filesystem atomic linearization point. No TTL/automatic steal.
// The caller must prove task CLOSED (or use separately audited recovery) to release.
export class AtomicClaims {
 constructor(root){if(typeof root!=='string'||root.length<2)throw new Error('Claim root required');this.root=root;}
 dir(key){return join(this.root,sha256(key));}
 async claim(key,owner){
  if(!key||!owner)throw new ControlError('CLAIM_ARGUMENT','Key and owner are required',400);
  await mkdir(this.root,{recursive:true,mode:0o700});
  const location=this.dir(key);
  try{await mkdir(location,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new ControlError('RESOURCE_LEASE_HELD','Existing ownership must be independently reconciled; no automatic stealing',409);throw e;}
  // Interrupted owner-file creation leaves a locked orphan by design, not a free lease.
  try{const f=await open(join(location,'owner.json'),'wx',0o600);try{await f.writeFile(JSON.stringify({v:1,owner,claimDigest:sha256(key)}));await f.sync();}finally{await f.close();}}
  catch(e){throw new ControlError('CLAIM_UNCERTAIN','Lease directory created, evidence incomplete; manual reconciliation required',503);}
  return {claimDigest:sha256(key),owner};
 }
 async check(key,owner){let r;try{r=JSON.parse(await readFile(join(this.dir(key),'owner.json'),'utf8'));}catch{throw new ControlError('RESOURCE_LEASE_UNVERIFIED','Lease evidence unavailable; fail closed',409);}
  if(r.v!==1||r.owner!==owner||r.claimDigest!==sha256(key))throw new ControlError('RESOURCE_LEASE_STALE','Lease owner or fencing epoch changed',409);
  return true;
 }
 async release(key,owner){await this.check(key,owner);await rm(this.dir(key),{recursive:true,force:false});}
}
export function serialize(owner,operation){
 const prior=owner.operationQueue||Promise.resolve();const pending=prior.then(operation,operation);
 owner.operationQueue=pending.then(()=>{},()=>{});return pending;
}
