import {ControlError} from './safety.mjs';

const RETRIABLE_READ_ERRORS=new Set(['CDP_UNAVAILABLE','CDP_DISCONNECTED','CDP_TIMEOUT','READ_TIMEOUT','ECONNRESET','ECONNREFUSED','ETIMEDOUT','PAGE_NOT_READY']);
export async function retryRead(fn,{delays=[80,180,300],sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 for(let i=0;;i++){
  try{return await fn();}
  catch(e){if(i>=delays.length||!RETRIABLE_READ_ERRORS.has(e.code))throw e;
    await sleep(delays[i]);}
 }
}
export function assertReadOnlyRetry(method){
 if(!['tabs','observe','field','describe'].includes(method))throw new ControlError('UNSAFE_RETRY','Only read-only operations can use automatic transport retries',403);
}
