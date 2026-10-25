import {readFile,open,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';

export class GatewayJournal {
 constructor(path){if(typeof path!=='string'||!path)throw new Error('Durable Gateway journal path required');this.path=path;this.states=new Map();this.ready=this.load();this.queue=Promise.resolve();}
 async load(){let data;try{data=await readFile(this.path,'utf8');}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const line of data.split('\n')){if(!line.trim())continue;let r;try{r=JSON.parse(line);}catch{throw new Error('GATEWAY_JOURNAL_CORRUPT');}
   if(r.v!==1||typeof r.id!=='string'||!['QUEUED','DISPATCHED','REPLIED','TIMED_OUT','ABORTED'].includes(r.phase))throw new Error('GATEWAY_JOURNAL_CORRUPT');
   this.states.set(r.id,r);
  }
 }
 async append(id,phase,metadata={}){await this.ready;const item={v:1,id,phase,at:new Date().toISOString(),...metadata};
   const run=async()=>{await mkdir(dirname(this.path),{recursive:true});const f=await open(this.path,'a',0o600);try{await f.writeFile(JSON.stringify(item)+'\n');await f.sync();}finally{await f.close();}};
   const promise=this.queue.then(run,run);this.queue=promise.then(()=>{},()=>{});await promise;
   this.states.set(id,item);return item;
 }
 async read(id){await this.ready;return this.states.get(id)||null;}
 status(record){if(!record)return 'UNKNOWN_JOB';return record.phase==='REPLIED'?'REPLY_COMMITTED':record.phase==='QUEUED'?'QUEUED_NOT_DELIVERED':record.phase==='DISPATCHED'||record.phase==='TIMED_OUT'?'UNCERTAIN_OUTCOME_NO_AUTO_REPLAY':'ABORTED';}
}
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
