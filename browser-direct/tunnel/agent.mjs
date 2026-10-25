import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

export class WindowsTunnelAgent{
 constructor({gatewayUrl,agentToken,agentId,localToken,localUrl='http://127.0.0.1:59422/mcp',localTests=false,fetcher=fetch}={}){
  const remote=new URL(gatewayUrl);const local=new URL(localUrl);
  if(!localTests&&remote.protocol!=='https:')throw new Error('Gateway must use HTTPS');
  if(local.protocol!=='http:'||local.hostname!=='127.0.0.1'||(!localTests&&local.port!=='59422')||local.pathname!=='/mcp')throw new Error('Agent may forward only to dedicated localhost MCP');
  if(!agentId||agentId.length<8||!agentToken||agentToken.length<32||!localToken||localToken.length<32)throw new Error('Exact agent ID and separate token secrets required');
  this.gateway=remote.origin;this.agentToken=agentToken;this.agentId=agentId;this.localToken=localToken;this.localUrl=local.href;this.fetcher=fetcher;this.localTests=localTests;
 }
 headers(){return {Authorization:`Bearer ${this.agentToken}`,'X-Liming-Agent-Id':this.agentId};}
 async next(){
  const r=await this.fetcher(`${this.gateway}/agent/next`,{headers:this.headers(),signal:AbortSignal.timeout(28000)});
  if(r.status===204)return null;if(!r.ok)throw new Error(`AGENT_NEXT_HTTP_${r.status}`);
  const item=await r.json();if(!item.requestId||!item.payload)throw new Error('INVALID_GATEWAY_ENVELOPE');return item;
 }
 async forward(item){
  let response;
  try{
   const r=await this.fetcher(this.localUrl,{method:'POST',headers:{Authorization:`Bearer ${this.localToken}`,'Content-Type':'application/json'},body:JSON.stringify(item.payload),signal:AbortSignal.timeout(23000)});
   if(!r.ok)throw new Error('LOCAL_HTTP_'+r.status);
   response=await r.json();
  }catch(e){response={jsonrpc:'2.0',id:item.payload.id??null,error:{code:-32030,message:'LOCAL_UNKNOWN_OUTCOME_DO_NOT_REPLAY'}};}
  const body=JSON.stringify({requestId:item.requestId,response});
  // Reposting the RESULT is safe; the local browser action is never re-executed here.
  for(let i=0;i<3;i++){
   try{const r=await this.fetcher(`${this.gateway}/agent/reply`,{method:'POST',headers:{...this.headers(),'Content-Type':'application/json'},body,signal:AbortSignal.timeout(8000)});
    if(r.ok)return {requestId:item.requestId,reported:true};if(r.status===409)return {requestId:item.requestId,reported:false,status:'GATEWAY_REQUEST_EXPIRED'};
   }catch{}await sleep(150*(i+1));
  }
  return {requestId:item.requestId,reported:false,status:'RESULT_DELIVERY_UNCERTAIN'};
 }
 async step(){const job=await this.next();if(!job)return {state:'IDLE'};return this.forward(job);}
 async loop({signal,report=()=>{}}={}){let backoff=250;while(!signal?.aborted){try{const r=await this.step();report({state:r?.status||'RUNNING',requestId:r?.requestId??null});backoff=250;}catch(e){report({state:'TRANSPORT_ERROR',code:String(e.message).slice(0,100)});await sleep(backoff);backoff=Math.min(backoff*2,15000);}}}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 const agent=new WindowsTunnelAgent({gatewayUrl:process.env.LIMING_GATEWAY_URL,agentToken:process.env.LIMING_GATEWAY_AGENT_TOKEN,agentId:process.env.LIMING_GATEWAY_AGENT_ID,localToken:process.env.LIMING_BROWSER_TOKEN});
 const abort=new AbortController();process.on('SIGINT',()=>abort.abort());process.on('SIGTERM',()=>abort.abort());
 agent.loop({signal:abort.signal,report:x=>console.log(JSON.stringify({ts:new Date().toISOString(),...x}))}).catch(e=>{console.error('TUNNEL_AGENT_FAILED '+e.message);process.exitCode=1;});
}
