import http from 'node:http';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import { ChromeCDPBrowser } from './cdp-browser.mjs';
import { BrowserController } from './controller.mjs';
import { DurableActionLedger } from './ledger.mjs';
import { DurableTaskRegistry } from './task-tabs.mjs';
import { HostAttestationGate } from './host-attestation.mjs';
import { ControlError, constantTimeTokenMatch } from './safety.mjs';

const obj={type:'object',additionalProperties:false};
const managedTaskScope={type:'object',required:['project','clientRef','legalEntityRef','entity','entityType','fy','period','formType','matter','xeroOrgRef','xeroOrgLabel','returnRef'],properties:Object.fromEntries(['project','clientRef','legalEntityRef','entity','entityType','fy','period','formType','matter','xeroOrgRef','xeroOrgLabel','returnRef'].map(k=>[k,{type:'string'}])),additionalProperties:false};
const activeFormGuard={type:'object',required:['formSelector','identitySelector','identityText'],additionalProperties:false,properties:{formSelector:{type:'string'},identitySelector:{type:'string'},identityText:{type:'string'}}};
const taskAnchors={type:'object',required:['client','year','form','organization','returnRef'],properties:Object.fromEntries(['client','year','form','organization','returnRef'].map(k=>[k,{type:'string'}])),additionalProperties:false};
const expectedFields={type:'array',minItems:1,maxItems:12,items:{type:'object',required:['selector','text'],properties:{selector:{type:'string'},text:{type:'string'}},additionalProperties:false}};
const requiredScope={type:'object',required:['project','entity','period','matter'],properties:{project:{type:'string'},entity:{type:'string'},period:{type:'string'},matter:{type:'string'}},additionalProperties:false};
const expectedPoststate={type:'object',properties:{url:{type:'string'},visibleTextIncludes:{type:'array',items:{type:'string'}},visibleTextExcludes:{type:'array',items:{type:'string'}},controlsIncludeLabel:{type:'array',items:{type:'string'}}},additionalProperties:false};
const action={type:'object',required:['kind'],properties:{kind:{type:'string',enum:['click','double_click','hover','drag','type','scroll','press','select','wait','navigate']},selector:{type:'string'},x:{type:'number'},y:{type:'number'},toX:{type:'number'},toY:{type:'number'},text:{type:'string'},value:{type:'string'},key:{type:'string'},deltaY:{type:'number'},deltaX:{type:'number'},ms:{type:'integer'},url:{type:'string'}},additionalProperties:false};
export const TOOLS=[
 {name:'browser_task_open',description:'Create a NEW owned Xero Chrome tab for exact client/reference, entity, FY, form, organisation and unique return. No tab reuse or automatic form entry.',inputSchema:{...obj,required:['scope','startUrl'],properties:{scope:managedTaskScope,startUrl:{type:'string'}}}},
 {name:'browser_task_create_return',description:'Only a provisionally locked, evidence-backed new return may click the explicit Create Draft button. Outcome uncertain until unique Return ID is read back.',inputSchema:{...obj,required:['taskId','idempotencyKey','action','verifiedObligationRef','duplicateSearchRef'],properties:{taskId:{type:'string'},idempotencyKey:{type:'string'},action,verifiedObligationRef:{type:'string'},duplicateSearchRef:{type:'string'}}}},
 {name:'browser_task_promote_return',description:'After exact new Xero Return ID is observable, atomically promote the provisional client/FY/form lease to the canonical organisation/Return lease.',inputSchema:{...obj,required:['taskId','returnRef'],properties:{taskId:{type:'string'},returnRef:{type:'string'}}}},
 {name:'browser_task_navigate',description:'Idempotently navigate ONLY the newly created unbound tab to an authorised Xero URL before binding.',inputSchema:{...obj,required:['taskId','url','idempotencyKey'],properties:{taskId:{type:'string'},url:{type:'string'},idempotencyKey:{type:'string'}}}},
 {name:'browser_task_prepare',description:'Before initial form binding, allow only read/navigation (Xero link, URL navigation, wait or scroll); forbid form inputs and buttons.',inputSchema:{...obj,required:['taskId','idempotencyKey','action'],properties:{taskId:{type:'string'},idempotencyKey:{type:'string'},action}}},
 {name:'browser_task_bind',description:'ONE full initial check of client, FY, form, organisation, unique Xero return; bind owned tab and create session.',inputSchema:{...obj,required:['taskId','anchors'],properties:{taskId:{type:'string'},anchors:taskAnchors,formGuard:activeFormGuard}}},
 {name:'browser_task_list',description:'Only own task IDs, tab IDs, ownership and hashed scope states; never expose client values.',inputSchema:{...obj,properties:{}}},
 {name:'browser_task_pause',description:'Pause one task without closing tab or editing fields; requires identity revalidation before resume.',inputSchema:{...obj,required:['taskId'],properties:{taskId:{type:'string'},reason:{type:'string'}}}},
 {name:'browser_task_resume',description:'Recheck full identity ONLY after pause, unexpected navigation, error, tab drift or interruption.',inputSchema:{...obj,required:['taskId','anchors'],properties:{taskId:{type:'string'},anchors:taskAnchors,formGuard:activeFormGuard}}},
 {name:'browser_task_recover',description:'After process restart, recover only an exact pre-journaled, still-open plugin-created Chrome target and scope; full revalidation.',inputSchema:{...obj,required:['taskId','scope','anchors'],properties:{taskId:{type:'string'},scope:managedTaskScope,anchors:taskAnchors,formGuard:activeFormGuard}}},
 {name:'browser_task_plan',description:'Freeze all mandatory return sections and an authoritative source/workpaper version, before any finalisation.',inputSchema:{...obj,required:['taskId','sections','workpaperVersion'],properties:{taskId:{type:'string'},sections:{type:'array',items:{type:'string'},minItems:2,maxItems:120},workpaperVersion:{type:'string'}}}},
 {name:'browser_task_checkpoint',description:'After verified Save and NEW document readback, checkpoint one planned section with a matching action receipt.',inputSchema:{...obj,required:['taskId','sectionId','verifyActionKey'],properties:{taskId:{type:'string'},sectionId:{type:'string'},verifyActionKey:{type:'string'}}}},
 {name:'browser_task_review_approve',description:'Requires signed independent external Xero tax domain review; cannot be self-approved by this plugin.',inputSchema:{...obj,required:['taskId','reviewReceipt'],properties:{taskId:{type:'string'},reviewReceipt:{type:'object'}}}},
 {name:'browser_task_finish',description:'Final UI identity/field audit only after ALL frozen sections are checkpointed. Returns AWAITING_DOMAIN_REVIEW; never auto-closes an unreviewed tax return.',inputSchema:{...obj,required:['taskId','expectedFields'],properties:{taskId:{type:'string'},expectedFields,closeTab:{type:'boolean'}}}},
 {name:'browser_task_close',description:'Close ONLY an owned tab after verified finalisation (or an untouched unbound tab). Never close other client tabs.',inputSchema:{...obj,required:['taskId'],properties:{taskId:{type:'string'}}}},
 {name:'browser_status',description:'Read the local browser controller readiness and profile attestation; never assert tunnel or Xero success.',inputSchema:{...obj,properties:{}}},
 {name:'browser_tabs',description:'List allowed Xero tabs only; no mutation.',inputSchema:{...obj,properties:{}}},
 {name:'browser_bind',description:'Bind exact client/entity/period/matter and 2+ observed page anchors to a browser tab. Read-only; issues a short-lived session.',inputSchema:{...obj,required:['tabId','scope','anchors'],properties:{tabId:{type:'string'},scope:requiredScope,anchors:{type:'array',minItems:2,maxItems:6,items:{type:'string'}}}}},
 {name:'browser_observe',description:'Read current visible controls, text, page hash and optionally screenshot. Requires prior bind.',inputSchema:{...obj,required:['sessionId'],properties:{sessionId:{type:'string'},screenshot:{type:'boolean'}}}},
 {name:'browser_act',description:'Execute exactly one frontend-specified Chrome action with current page revision and idempotency; never auto-plan. Irreversible controls are blocked.',inputSchema:{...obj,required:['sessionId','idempotencyKey','action'],properties:{sessionId:{type:'string'},expectedRevision:{type:'string'},idempotencyKey:{type:'string'},action,expectedPoststate}}},
 {name:'browser_fill_fields',description:'Fast, same-CDP-connection sequential entry for up to 12 frontend-specified fields. Exact per-field value readback, bounded fallback only if initial input unchanged. Never claims Xero Draft saved.',inputSchema:{...obj,required:['sessionId','idempotencyKey','fields'],properties:{sessionId:{type:'string'},expectedRevision:{type:'string'},idempotencyKey:{type:'string'},fields:{type:'array',minItems:1,maxItems:12,items:{type:'object',required:['selector','text'],properties:{selector:{type:'string'},text:{type:'string',maxLength:4096},fallbackSelector:{type:'string'},expectedLabel:{type:'string'}},additionalProperties:false}}}}},
 {name:'browser_verify_saved',description:'After a verified same-session Save action, reload exact tab and independently compare persisted fields. Never performs Save or Lodge.',inputSchema:{...obj,required:['sessionId','expectedRevision','idempotencyKey','saveActionKey','fields'],properties:{sessionId:{type:'string'},expectedRevision:{type:'string'},idempotencyKey:{type:'string'},saveActionKey:{type:'string'},fields:{type:'array',minItems:1,maxItems:12,items:{type:'object',required:['selector','text'],properties:{selector:{type:'string'},text:{type:'string',maxLength:4096}},additionalProperties:false}}}}},
 {name:'browser_release',description:'Release one exact browser binding.',inputSchema:{...obj,required:['sessionId'],properties:{sessionId:{type:'string'}}}}
];

const resultText=data=>[{type:'text',text:JSON.stringify(data)}];
export async function dispatchMcp(payload,controller) {
  const {method,params={},id}=payload;
  if(payload.jsonrpc!=='2.0'||typeof method!=='string')return {jsonrpc:'2.0',id:id??null,error:{code:-32600,message:'Invalid JSON-RPC request'}};
  let answer;
  try {
    switch(method){
      case 'initialize':answer={protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'liming-browser-direct',version:'0.5.0'}};break;
      case 'ping':answer={};break;
      case 'tools/list':answer={tools:TOOLS};break;
      case 'tools/call':{
        const name=params.name,args=params.arguments??{};
        if(typeof args!=='object'||args===null||Array.isArray(args))throw new ControlError('BAD_ARGS','Arguments must be an object');
        let data;
        switch(name){
          case 'browser_task_open':data=await controller.taskOpen(args);break;
          case 'browser_task_navigate':data=await controller.taskNavigate(args);break;
          case 'browser_task_create_return':data=await controller.taskCreateReturn(args);break;
          case 'browser_task_promote_return':data=await controller.taskPromoteReturn(args);break;
          case 'browser_task_prepare':data=await controller.taskPrepare(args);break;
          case 'browser_task_bind':data=await controller.taskBind(args);break;
          case 'browser_task_list':data=await controller.taskList();break;
          case 'browser_task_pause':data=await controller.taskPause(args);break;
          case 'browser_task_resume':data=await controller.taskResume(args);break;
          case 'browser_task_recover':data=await controller.taskRecover(args);break;
          case 'browser_task_plan':data=await controller.taskPlan(args);break;
          case 'browser_task_checkpoint':data=await controller.taskCheckpoint(args);break;
          case 'browser_task_review_approve':data=await controller.taskReviewApprove(args);break;
          case 'browser_task_finish':data=await controller.taskFinish(args);break;
          case 'browser_task_close':data=await controller.taskClose(args);break;
          case 'browser_status':data=await controller.status();break;
          case 'browser_tabs':data=await controller.tabs();break;
          case 'browser_bind':data=await controller.bind(args);break;
          case 'browser_observe':data=await controller.observe(args);break;
          case 'browser_act':data=await controller.act(args);break;
          case 'browser_fill_fields':data=await controller.fillFields(args);break;
          case 'browser_verify_saved':data=await controller.verifySaved(args);break;
          case 'browser_release':data=controller.release(args);break;
          default:throw new ControlError('UNKNOWN_TOOL','Unknown browser tool',404);
        }
        if(name==='browser_observe'&&data.screenshot){
          const img=data.screenshot;delete data.screenshot;
          answer={content:[...resultText(data),{type:'image',data:img.base64,mimeType:img.mimeType}],isError:false};
        }else answer={content:resultText(data),isError:false};
        break;
      }
      case 'notifications/initialized':return null;
      default:return {jsonrpc:'2.0',id:id??null,error:{code:-32601,message:'Method not found'}};
    }
    if(id===undefined||id===null)return null;
    return {jsonrpc:'2.0',id,result:answer};
  }catch(err){
    if(method==='tools/call')return {jsonrpc:'2.0',id:id??null,result:{content:resultText({code:err.code||'ACTUATOR_FAILURE',message:String(err.message||'Browser tool failed').slice(0,300),status:err.status||500}),isError:true}};
    return {jsonrpc:'2.0',id:id??null,error:{code:-32603,message:'Operation failed'}};
  }
}
export function createServer({token,controller=new BrowserController(new ChromeCDPBrowser()),port=59422,host='127.0.0.1',allowedOrigins=[]}={}){
  if(typeof token!=='string'||token.length<32)throw new Error('LIMING_BROWSER_TOKEN must be at least 32 characters');
  if(host!=='127.0.0.1')throw new Error('Browser local MCP must bind to 127.0.0.1 only');
  const server=http.createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
    if(req.url==='/healthz'&&req.method==='GET')return send(200,{live:true,service:'liming-browser-direct'});
    if(req.url==='/readyz'&&req.method==='GET'){
      const auth=req.headers.authorization||'';
      if(!constantTimeTokenMatch(token,auth.startsWith('Bearer ')?auth.slice(7):''))return send(401,{error:'Unauthorized'});
      const status=await controller.status();return send(200,{server_ready:true,cdp_reachable:status.cdp_reachable===true,write_ready:status.cdp_reachable===true&&status.profile_attested===true&&status.wal_durable===true,profile_reason:status.owner_attestation?.reason||null});
    }
    if(req.url!== '/mcp' || req.method!=='POST')return send(404,{error:'Not found'});
    const origin=req.headers.origin;
    if(origin&&!allowedOrigins.includes(origin))return send(403,{error:'Origin not allowed'});
    const auth=req.headers.authorization||'';
    if(!constantTimeTokenMatch(token,auth.startsWith('Bearer ')?auth.slice(7):''))return send(401,{error:'Unauthorized'});
    if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))return send(415,{error:'Content-Type application/json required'});
    const body=[];let size=0;
    for await (const chunk of req){size+=chunk.length;if(size>131072)return send(413,{error:'Body too large'});body.push(chunk);}
    let payload;try{payload=JSON.parse(Buffer.concat(body).toString('utf8'));}catch{return send(400,{error:'Invalid JSON'});}
    const output=await dispatchMcp(payload,controller);
    if(output===null){res.writeHead(202);return res.end();}
    send(200,output);
  });
  server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  return {server,listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolve(server.address()));})};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  const token=process.env.LIMING_BROWSER_TOKEN;
  // A manual attested=1 environment flag is NOT trusted for production browser writes.
  const attestationGate=new HostAttestationGate({expectedUserDataDir:process.env.LIMING_EXPECTED_CHROME_USER_DATA_DIR,expectedProfileDirectory:process.env.LIMING_EXPECTED_CHROME_PROFILE_DIRECTORY,expectedExecutablePath:process.env.LIMING_EXPECTED_CHROME_EXE});
  const ledgerPath=process.env.LIMING_ACTION_LEDGER_PATH;
  if(!ledgerPath)throw new Error('LIMING_ACTION_LEDGER_PATH required for durable replay protection');
  const taskPath=process.env.LIMING_TASK_LEDGER_PATH;
  if(!taskPath||taskPath===ledgerPath)throw new Error('Separate LIMING_TASK_LEDGER_PATH required for multi-client tab ownership');
  const controller=new BrowserController(new ChromeCDPBrowser(),{attestationGate,localTests:false,ledger:new DurableActionLedger(ledgerPath),taskRegistry:new DurableTaskRegistry(taskPath),requireManagedTasks:true,reviewPublicKey:process.env.LIMING_DOMAIN_REVIEW_PUBKEY_FILE?readFileSync(process.env.LIMING_DOMAIN_REVIEW_PUBKEY_FILE):null});
  const port=Number(process.env.LIMING_BROWSER_PORT||59422);if(port!==59422)throw new Error('Production local MCP must use the dedicated 59422 port');
  const {listen}=createServer({token,controller,port,host:'127.0.0.1',allowedOrigins:(process.env.LIMING_ALLOWED_ORIGINS||'').split(',').filter(Boolean)});
  listen().then(addr=>console.log(JSON.stringify({state:'LISTENING',host:addr.address,port:addr.port,profileAttested:'live_runtime_check_required'}))).catch(e=>{console.error('STARTUP_FAILED '+e.message);process.exitCode=1;});
}
