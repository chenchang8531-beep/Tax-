import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {constantTimeTokenMatch} from '../runtime/src/safety.mjs';

// A narrow, independent HTTP long-poll reverse tunnel: no browser, planning or data store in the cloud.
const json=(res,code,data)=>{if(res.headersSent)return;res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
const auth=(req,token)=>{const h=String(req.headers.authorization||'');return constantTimeTokenMatch(token,h.startsWith('Bearer ')?h.slice(7):'');};
async function jsonBody(req,max=131072){
 const parts=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>max)throw Object.assign(new Error('BODY_TOO_LARGE'),{status:413});parts.push(chunk);}
 let x;try{x=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Object.assign(new Error('BAD_JSON'),{status:400});}
 if(!x||typeof x!=='object'||Array.isArray(x))throw Object.assign(new Error('BAD_JSON'),{status:400});return x;
}
export function createGateway({frontendToken,agentToken,agentId,localTests=false,now=Date.now,maxQueued=8,agentLeaseMs=35000,clientTimeoutMs=30000,waitNextMs=22000}={}){
 if([frontendToken,agentToken].some(x=>typeof x!=='string'||x.length<32)||frontendToken===agentToken)throw new Error('Two distinct random tokens of at least 32 chars are required');
 if(typeof agentId!=='string'||agentId.length<8||agentId.length>100)throw new Error('Exact gateway agent identity required');
 let lastAgentSeen=0,closed=false,waiter=null;const queue=[],pending=new Map();
 const online=()=>lastAgentSeen>0&&now()-lastAgentSeen<=agentLeaseMs;
 const deliver=()=>{
  while(waiter&&queue.length){const res=waiter.res;clearTimeout(waiter.timer);waiter=null;if(res.destroyed)continue;
   const request=queue.shift();request.dispatched=true;json(res,200,{requestId:request.id,payload:request.payload});}
 };
 const server=http.createServer(async(req,res)=>{
  const route=(req.url||'').split('?')[0];
  if(route==='/healthz'&&req.method==='GET')return json(res,200,{live:true,service:'liming-browser-reverse-gateway'});
  if(!localTests&&req.headers['x-forwarded-proto']!=='https')return json(res,426,{error:'HTTPS_REQUIRED_BEHIND_TRUSTED_PROXY'});
  if(route==='/status'&&req.method==='GET'){
   if(!auth(req,frontendToken))return json(res,401,{error:'UNAUTHORIZED'});
   return json(res,200,{agent_online:online(),pending:pending.size,queued:queue.length,transport:'outbound_https_long_poll',replay_on_unknown:false});
  }
  if(route==='/mcp'&&req.method==='POST'){
   if(!auth(req,frontendToken))return json(res,401,{error:'UNAUTHORIZED'});
   if(!online())return json(res,503,{error:'AGENT_OFFLINE'});
   if(queue.length>=maxQueued||pending.size>=maxQueued)return json(res,429,{error:'BACKPRESSURE'});
   let payload;try{payload=await jsonBody(req);}catch(e){return json(res,e.status||400,{error:e.message});}
   if(payload.jsonrpc!=='2.0'||typeof payload.method!=='string')return json(res,400,{error:'INVALID_MCP_REQUEST'});
   const id=randomUUID(),item={id,payload,res,dispatched:false,createdAt:now(),done:false};pending.set(id,item);queue.push(item);
   item.timer=setTimeout(()=>{if(item.done)return;item.done=true;json(res,504,{error:'UNKNOWN_OUTCOME_NO_AUTOREPLAY',requestId:id});
     // If an agent already started the request, keep it until its eventual reply to record the late outcome.
     if(!item.dispatched){const index=queue.indexOf(item);if(index>=0)queue.splice(index,1);pending.delete(id);}
   },clientTimeoutMs);item.timer.unref?.();
   deliver();return;
  }
  if(route.startsWith('/agent/')){
   if(!auth(req,agentToken)||req.headers['x-liming-agent-id']!==agentId)return json(res,401,{error:'AGENT_AUTH_DENIED'});
   lastAgentSeen=now();
   if(route==='/agent/next'&&req.method==='GET'){
     if(waiter)return json(res,409,{error:'AGENT_POLL_ALREADY_ACTIVE'});
     waiter={res,timer:setTimeout(()=>{if(waiter?.res===res){waiter=null;res.writeHead(204,{'cache-control':'no-store'});res.end();}},waitNextMs)};
     waiter.timer.unref?.();res.on('close',()=>{if(waiter?.res===res){clearTimeout(waiter.timer);waiter=null;}});
     deliver();return;
   }
   if(route==='/agent/reply'&&req.method==='POST'){
     let body;try{body=await jsonBody(req,6000000);}catch(e){return json(res,e.status||400,{error:e.message});}
     if(typeof body.requestId!=='string'||!body.response||typeof body.response!=='object')return json(res,400,{error:'BAD_REPLY'});
     const item=pending.get(body.requestId);
     if(!item)return json(res,409,{error:'UNKNOWN_REQUEST_ID'});
     if(!item.dispatched)return json(res,409,{error:'NOT_DISPATCHED'});
     clearTimeout(item.timer);pending.delete(item.id);
     const wasLate=item.done;
     if(!wasLate){item.done=true;json(item.res,200,body.response);}
     return json(res,200,{accepted:true,requestId:item.id,late:wasLate});
   }
  }
  return json(res,404,{error:'NOT_FOUND'});
 });
 server.requestTimeout=60000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
 return {server,listen:(port=Number(process.env.PORT||8080),host=localTests?'127.0.0.1':'0.0.0.0')=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolve(server.address()));}),status:()=>({online:online(),queued:queue.length,pending:pending.size}),close:()=>{closed=true;for(const item of pending.values()){clearTimeout(item.timer);json(item.res,503,{error:'GATEWAY_SHUTDOWN_UNKNOWN_OUTCOME'});}if(waiter){clearTimeout(waiter.timer);json(waiter.res,503,{error:'GATEWAY_SHUTDOWN'});}return new Promise(r=>server.close(r));}};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 const opts={frontendToken:process.env.LIMING_GATEWAY_FRONTEND_TOKEN,agentToken:process.env.LIMING_GATEWAY_AGENT_TOKEN,agentId:process.env.LIMING_GATEWAY_AGENT_ID,localTests:false};
 const server=createGateway(opts);
 server.listen().then(addr=>console.log(JSON.stringify({service:'liming-browser-reverse-gateway',version:'0.3.1',bound:addr.address,port:addr.port,transport:'HTTPS_TERMINATED_BY_TRUSTED_PROXY'}))).catch(e=>{console.error('GATEWAY_FAILED '+e.message);process.exitCode=1;});
}
