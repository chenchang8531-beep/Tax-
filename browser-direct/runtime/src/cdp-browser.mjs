import { ControlError, allowedUrl } from './safety.mjs';

const CDP_BASE = 'http://127.0.0.1:9222';
const timeoutMs = 7500;
function checkWsUrl(address, expectedPort='9222') {
  let url;try{url=new URL(address);}catch{throw new ControlError('BAD_CDP_URL','Invalid Chrome websocket target',502);}
  if(url.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.port!==expectedPort)throw new ControlError('BAD_CDP_URL','CDP must remain bound to loopback 9222',502);
  return url.href;
}
class ProtocolSession {
  constructor(ws){this.ws=ws;this.pending=new Map();this.nextId=1;this.closed=false;
    ws.addEventListener('message',evt=>{
      let data;try{data=JSON.parse(String(evt.data));}catch{return;}
      if(!data.id||!this.pending.has(data.id))return;
      const item=this.pending.get(data.id);this.pending.delete(data.id);clearTimeout(item.timer);
      if(data.error)item.reject(new ControlError('CDP_ERROR',data.error.message||'CDP error',502));
      else item.resolve(data.result||{});
    });
    ws.addEventListener('close',()=>{this.closed=true;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new ControlError('CDP_DISCONNECTED','Chrome target disconnected',502));}this.pending.clear();});
  }
  send(method,params={}) {
    if(this.closed)throw new ControlError('CDP_DISCONNECTED','CDP target disconnected',502);
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new ControlError('CDP_TIMEOUT',`CDP command timed out: ${method}`,504));},timeoutMs);
      this.pending.set(id,{timer,resolve,reject});
      try{this.ws.send(JSON.stringify({id,method,params}));}catch(e){this.pending.delete(id);clearTimeout(timer);reject(e);}
    });
  }
  close(){try{this.ws.close();}catch{}}
}
async function connect(address, port) {
  const ws=new WebSocket(checkWsUrl(address,port));
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.close();reject(new ControlError('CDP_TIMEOUT','WebSocket opening timed out',504));},5000);
    ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    ws.addEventListener('error',()=>{clearTimeout(timer);reject(new ControlError('CDP_UNAVAILABLE','WebSocket connection failed',502));},{once:true});
  });
  return new ProtocolSession(ws);
}
const js = expression=>({expression,returnByValue:true,awaitPromise:false,userGesture:false});
function nodeTargetScript(action){
  // Escaped JSON literal only, never executes arbitrary frontend JavaScript.
  const selector=action.selector?JSON.stringify(action.selector):'null';
  const x=Number.isFinite(action.x)?action.x:'null';const y=Number.isFinite(action.y)?action.y:'null';
  return `(() => {
   if(window.__limingTabIdentityGuard&&!window.__limingTabIdentityGuard.check())return {error:'TASK_REVALIDATION_REQUIRED'};
   let el;try { if(${selector}){const matches=[...document.querySelectorAll(${selector})];if(matches.length!==1)return {error:'AMBIGUOUS_TARGET'};el=matches[0];}else el=document.elementFromPoint(${x},${y}); }catch(e){return {error:'INVALID_SELECTOR'}}
   if(!el) return {error:'TARGET_NOT_FOUND'};
   el=el.closest('button,a,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[role="option"],[contenteditable],label')||el;
   el.scrollIntoView({block:'nearest',inline:'nearest'});
   const r=el.getBoundingClientRect();const style=getComputedStyle(el);
   const visible=r.width>0&&r.height>0&&style.visibility!=='hidden'&&style.display!=='none';
   const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
   const pointerOccluded=Boolean(hit&&!el.contains(hit)&&!hit.contains(el));
   const parentForm=el.closest('form');
   return {label:String(el.getAttribute('aria-label')||el.labels?.[0]?.innerText||el.innerText||el.value||'').slice(0,220),
     text:String(el.innerText||'').slice(0,180), title:String(el.title||'').slice(0,120),
     ariaLabel:String(el.getAttribute('aria-label')||'').slice(0,180),href:String(el.href||'').slice(0,300),
     formAction:String(parentForm?.action||'').slice(0,300),inForm:Boolean(parentForm),type:String(el.type||''),role:String(el.getAttribute('role')||''),tag:el.tagName,
     password:el.type==='password',isEditableSecret:Boolean(el.matches('input[autocomplete="current-password"], input[autocomplete="new-password"]')),pointerOccluded,visible,disabled:Boolean(el.disabled),x:r.x+r.width/2,y:r.y+r.height/2,
     inViewport:r.x>=0&&r.y>=0&&r.x+r.width<=innerWidth+1&&r.y+r.height<=innerHeight+1,
     width:r.width,height:r.height};
  })()`;
}
const observeScript=`(() => {
 const visible=(el)=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
 const controls=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[role="option"],[contenteditable="true"]')]
   .filter(visible).slice(0,150).map((el,i)=>({index:i,tag:el.tagName,role:el.getAttribute('role')||'',
     label:String(el.getAttribute('aria-label')||el.labels?.[0]?.innerText||el.innerText||el.placeholder||'').trim().slice(0,140),
     type:el.type||'',disabled:Boolean(el.disabled),
     value:el.type==='password'?'[REDACTED]':(el.matches('input,textarea') ? (/pass(word)?|tfn|dob|birth|bsb|bank|routing|account.?number/i.test([el.name,el.id,el.getAttribute('aria-label'),el.placeholder].join(' ')) ? '[REDACTED]' : String(el.value||'').slice(0,120)) : undefined),
     box:(()=>{const r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()}));
 return {url:location.href,title:document.title,visibleText:String(document.body?.innerText||'').slice(0,12000),controls,
     viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio}};
})()`;


const fieldScript=selector=>`(() => {
  let elements;try{elements=[...document.querySelectorAll(${JSON.stringify(selector)})];}catch{return {count:0,exists:false,invalidSelector:true}}
  const el=elements[0];if(elements.length!==1)return {count:elements.length,exists:Boolean(el)};
  const tag=el.tagName;const editable=el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||el.isContentEditable;
  const r=el.getBoundingClientRect(),css=getComputedStyle(el),visible=r.width>0&&r.height>0&&css.visibility!=='hidden'&&css.display!=='none';
  const type=String(el.type||'text');const sensitive=type==='password';
  const label=String(el.getAttribute('aria-label')||el.labels?.[0]?.innerText||el.getAttribute('placeholder')||'').slice(0,160);
  const value=sensitive ? null : (el.isContentEditable?String(el.textContent||''):String(el.value??''));
  return {count:1,exists:true,visible,enabled:!el.disabled,readOnly:Boolean(el.readOnly),editable,tag,type,label,value,
      x:r.x+r.width/2,y:r.y+r.height/2,url:location.href,documentToken:performance.timeOrigin,guardInstalled:Boolean(window.__limingTabIdentityGuard),guardDirty:Boolean(window.__limingTabIdentityGuard?.dirty)||Boolean(window.__limingTabIdentityGuard&&!window.__limingTabIdentityGuard.check())};
})()`;
const focusScript=selector=>`(() => {
  if(window.__limingTabIdentityGuard&&!window.__limingTabIdentityGuard.check())return {ok:false,code:'TASK_REVALIDATION_REQUIRED'};
  let found;try{found=[...document.querySelectorAll(${JSON.stringify(selector)})];}catch{return {ok:false,code:'INVALID_SELECTOR'}}
  if(found.length!==1)return {ok:false,code:'AMBIGUOUS_FIELD'};
  const el=found[0],tag=el.tagName;
  if(el.type==='password'||!['INPUT','TEXTAREA'].includes(tag)&&!el.isContentEditable)return {ok:false,code:'NON_EDITABLE'};
  if(el.disabled||el.readOnly)return {ok:false,code:'FIELD_UNAVAILABLE'};
  el.focus();
  if(typeof el.select==='function')el.select();
  else {const sel=window.getSelection(),range=document.createRange();range.selectNodeContents(el);sel.removeAllRanges();sel.addRange(range);}
  return {ok:document.activeElement===el};
})()`;

export class ChromeCDPBrowser {
  constructor({base=CDP_BASE,localTests=false}={}){
    const b=new URL(base);
    if(b.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(b.hostname))throw new Error('Chrome CDP endpoint must be loopback HTTP');
    if(!localTests && b.port!=='9222')throw new Error('Production Chrome CDP target must remain port 9222');
    this.base=b.origin;this.port=b.port||'80';this.localTests=localTests;
  }
  async fetchJson(path){const r=await fetch(`${this.base}${path}`,{signal:AbortSignal.timeout(5000)});
    if(!r.ok)throw new ControlError('CDP_UNAVAILABLE',`CDP HTTP returned ${r.status}`,502);return r.json();}
  async tabs(){const tabs=await this.fetchJson('/json/list');return tabs.filter(t=>t.type==='page').map(t=>({id:t.id,title:t.title,url:t.url}));}
  async createTab(address){
    if(!allowedUrl(address,{localTests:this.localTests}))throw new ControlError('ORIGIN_BLOCKED','New tab must start on an approved Xero URL',403);
    // Chrome DevTools HTTP interface requires PUT for /json/new. Never act on an existing tab.
    const response=await fetch(`${this.base}/json/new?${encodeURIComponent(address)}`,{method:'PUT',signal:AbortSignal.timeout(9000)});
    if(!response.ok)throw new ControlError('TAB_CREATION_FAILED',`Chrome refused new tab: ${response.status}`,502);
    const created=await response.json();
    if(created.type!=='page'||typeof created.id!=='string'||created.id.length>120)throw new ControlError('TAB_CREATION_UNCERTAIN','New Chrome target ID was not returned',502);
    return {id:created.id,url:created.url||address};
  }
  async closeTab(tabId){
    const current=await this.tabs();
    if(!current.some(x=>x.id===tabId))throw new ControlError('TAB_MISSING','Owned Chrome target no longer exists; closure not proven',409);
    const response=await fetch(`${this.base}/json/close/${encodeURIComponent(tabId)}`,{signal:AbortSignal.timeout(7000)});
    if(!response.ok)throw new ControlError('TAB_CLOSE_UNCERTAIN',`Chrome did not confirm owned tab closing: ${response.status}`,502);
    for(let i=0;i<15;i++){
      if(!(await this.tabs()).some(x=>x.id===tabId))return {closed:true,tabId};
      await new Promise(r=>setTimeout(r,75));
    }
    throw new ControlError('TAB_CLOSE_UNCERTAIN','Chrome target still exists after close command',502);
  }
  async lightweightProbe(tabId){return this.withTab(tabId,c=>this.lightweightProbeOn(c));}
  async installIdentityGuard(tabId,anchors,spec){return this.withTab(tabId,c=>this.installIdentityGuardOn(c,anchors,spec));}
  async installIdentityGuardOn(c,anchors,spec){
    await this.assertOrigin(c);
    if(!Array.isArray(anchors)||anchors.length<4||anchors.length>6)throw new ControlError('TASK_ANCHORS_REQUIRED','Four identity anchors required');
    // Real Xero must supply an independently observed active FORM container and identity element.
    // A page-wide header/whole-body substring is not sufficient to attest an active return.
    if(!spec && !this.localTests)throw new ControlError('ACTIVE_FORM_GUARD_REQUIRED','A scoped active Xero Return DOM selector is required',409);
    if(spec && (typeof spec.formSelector!=='string'||!spec.formSelector||spec.formSelector.length>250||typeof spec.identitySelector!=='string'||!spec.identitySelector||spec.identitySelector.length>250||typeof spec.identityText!=='string'||spec.identityText.length<3||spec.identityText.length>180))
      throw new ControlError('ACTIVE_FORM_GUARD_REQUIRED','Invalid active form identity contract',409);
    const selector=spec?.formSelector||'body';const identitySelector=spec?.identitySelector||'#identity';
    const identityText=spec?.identityText||anchors[0];
    const script=`(() => {
      if(window.__limingTabIdentityGuard?.observer)window.__limingTabIdentityGuard.observer.disconnect();
      const rootMatches=[...document.querySelectorAll(${JSON.stringify(selector)})];
      if(rootMatches.length!==1)return {installed:false,reason:'ACTIVE_FORM_NOT_UNIQUE'};
      const root=rootMatches[0], identities=[...root.querySelectorAll(${JSON.stringify(identitySelector)})];
      if(identities.length!==1)return {installed:false,reason:'ACTIVE_IDENTITY_NOT_UNIQUE'};
      const identity=identities[0],expected=${JSON.stringify(identityText.toLocaleLowerCase())};
      const guard={dirty:false,observer:null,formSelector:${JSON.stringify(selector)},identitySelector:${JSON.stringify(identitySelector)}};
      guard.check=()=>{const active=[...document.querySelectorAll(guard.formSelector)];
        if(active.length!==1||active[0]!==root||!root.isConnected||!identity.isConnected||
          !root.contains(identity)||[...root.querySelectorAll(guard.identitySelector)].length!==1||
          !String(identity.textContent||'').toLocaleLowerCase().includes(expected))guard.dirty=true;
        return !guard.dirty;};
      if(!guard.check())return {installed:false,reason:'ACTIVE_IDENTITY_MISMATCH'};
      guard.observer=new MutationObserver(()=>{guard.check()});
      guard.observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-return-id','data-client-id','aria-selected']});
      Object.defineProperty(window,'__limingTabIdentityGuard',{value:guard,configurable:true,writable:false});
      return {installed:true,dirty:false};
    })()`;
    const status=await this.evaluate(c,script);
    if(!status?.installed||status.dirty)throw new ControlError('TASK_GUARD_UNAVAILABLE','Active form identity guard did not install: '+String(status?.reason||'UNKNOWN'),409);
    return status;
  }
  async lightweightProbeOn(c){await this.assertOrigin(c);return this.evaluate(c,'({url:location.href,documentToken:performance.timeOrigin,readyState:document.readyState,guardInstalled:Boolean(window.__limingTabIdentityGuard),guardDirty:Boolean(window.__limingTabIdentityGuard?.dirty)||Boolean(window.__limingTabIdentityGuard&&!window.__limingTabIdentityGuard.check())})');}
  async withTab(tabId,fn){
    const tabs=await this.fetchJson('/json/list');const tab=tabs.find(t=>t.type==='page'&&t.id===tabId);
    if(!tab?.webSocketDebuggerUrl)throw new ControlError('TAB_MISSING','Chrome CDP tab missing',404);
    if(!allowedUrl(tab.url,{localTests:this.localTests}))throw new ControlError('ORIGIN_DRIFT','Tab is no longer on approved origin',403);
    const c=await connect(tab.webSocketDebuggerUrl,this.port);try{return await fn(c);}finally{c.close();}
  }
  async evaluate(c,expression){
    const r=await c.send('Runtime.evaluate',js(expression));
    if(r.exceptionDetails)throw new ControlError('DOM_READ_FAILED','Chrome DOM evaluation failed',502);
    return r.result?.value;
  }
  async assertOrigin(c){const address=await this.evaluate(c,'location.href');
    if((address==='about:blank'&&!this.localTests)||typeof address!=='string')throw new ControlError('PAGE_NOT_READY','Chrome tab has not finished initial navigation',503);
    if(!allowedUrl(address,{localTests:this.localTests}))throw new ControlError('ORIGIN_DRIFT','Tab navigated outside permitted origin',403);}
  async observeOn(c){await this.assertOrigin(c);return this.evaluate(c,observeScript);}
  async describeTargetOn(c,action){
    await this.assertOrigin(c);
    const target=await this.evaluate(c,nodeTargetScript(action));
    if(target?.error)throw new ControlError(target.error,'Browser target cannot be identified',409);
    if(!target?.visible||target.disabled||!target.inViewport)throw new ControlError('TARGET_UNAVAILABLE','Target hidden/disabled/offscreen',409);
    return target;
  }
  async readFieldOn(c,selector){await this.assertOrigin(c);return this.evaluate(c,fieldScript(selector));}
  async setFieldOn(c,field,mode='fast'){
    await this.assertOrigin(c);const status=await this.evaluate(c,focusScript(field.selector));
    if(!status?.ok)throw new ControlError(status?.code||'FIELD_FOCUS_FAILED','Field could not be uniquely focused',409);
    if(mode==='fast'){
      if(field.text===''){await c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Backspace',windowsVirtualKeyCode:8});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',windowsVirtualKeyCode:8});}
      else await c.send('Input.insertText',{text:field.text});
    }
    else if(mode==='keyed'){
      if([...field.text].length>512)throw new ControlError('FALLBACK_SIZE_LIMIT','Keyed fallback capped at 512 codepoints',409);
      for(const character of field.text)await c.send('Input.insertText',{text:character});
    }else throw new ControlError('BAD_MODE','Unsupported input strategy',400);
  }
  async performOn(c,action,element={}){
    await this.assertOrigin(c);
    switch(action.kind){
      case 'hover':await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:element.x,y:element.y});break;
      case 'double_click':{
        for(let i=1;i<=2;i++){await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:element.x,y:element.y,button:'left',clickCount:i});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:element.x,y:element.y,button:'left',clickCount:i});}break;
      }
      case 'drag':{
        const x=action.x,y=action.y;
        await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
        await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
        for(let i=1;i<=8;i++){const k=i/8;await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+(action.toX-x)*k,y:y+(action.toY-y)*k,button:'left',buttons:1});}
        await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:action.toX,y:action.toY,button:'left',clickCount:1});break;
      }
      case 'click':{
        const x=element.x,y=element.y;
        await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
        await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
        await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});break;
      }
      case 'type':await this.setFieldOn(c,{selector:action.selector,text:action.text},'fast');break;
      case 'press':{
        const selector=JSON.stringify(action.selector);
        await this.evaluate(c,`(()=>{const el=document.querySelector(${selector});if(el)el.focus();return Boolean(el)})()`);
        const keys={Tab:9,Enter:13,Escape:27,Backspace:8,Delete:46,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Space:32};
        const vk=keys[action.key];
        await c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:action.key,windowsVirtualKeyCode:vk});
        await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:action.key,windowsVirtualKeyCode:vk});break;
      }
      case 'scroll':{
        const size=await this.evaluate(c,'({width:innerWidth,height:innerHeight})');
        await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:action.x??size.width/2,y:action.y??size.height/2,deltaX:action.deltaX??0,deltaY:action.deltaY});break;
      }
      case 'select':{
        const selector=JSON.stringify(action.selector),value=JSON.stringify(action.value);
        const result=await this.evaluate(c,`(()=>{const el=document.querySelector(${selector});if(!(el instanceof HTMLSelectElement))return {ok:false};if(![...el.options].some(x=>x.value===${value}))return {ok:false};el.value=${value};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:el.value===${value}}})()`);
        if(!result?.ok)throw new ControlError('SELECT_FAILED','Native SELECT option not available',409);break;
      }
      case 'navigate':await c.send('Page.navigate',{url:action.url});break;
      default:throw new ControlError('UNSUPPORTED_ACTION','Browser actuator does not support action');
    }
  }
  async transaction(tabId,fn){return this.withTab(tabId,async c=>fn({
    observe:()=>this.observeOn(c),lightweightProbe:()=>this.lightweightProbeOn(c),installIdentityGuard:(a,s)=>this.installIdentityGuardOn(c,a,s),describeTarget:a=>this.describeTargetOn(c,a),readField:s=>this.readFieldOn(c,s),reload:()=>this.reloadOn(c),
    setField:(f,m)=>this.setFieldOn(c,f,m),perform:(a,el)=>this.performOn(c,a,el)
  }));}
  async reloadOn(c){
    await this.assertOrigin(c);
    const previous=await this.evaluate(c,'performance.timeOrigin');
    await c.send('Page.reload',{ignoreCache:false});
    // Page.reload ACK alone is not document navigation. Require a NEW Performance time origin.
    for(let i=0;i<55;i++){
      await new Promise(r=>setTimeout(r,200));
      try{const state=await this.evaluate(c,'({ready:document.readyState,origin:performance.timeOrigin})');
        if(state?.ready==='complete'&&Number.isFinite(state.origin)&&state.origin!==previous){await this.assertOrigin(c);return {documentChanged:true};}}
      catch{} // CDP Runtime execution context may be destroyed during navigation.
    }
    throw new ControlError('RELOAD_TIMEOUT','No independently new ready document after reload',504);
  }
  async observe(tabId){return this.withTab(tabId,c=>this.observeOn(c));}
  async describeTarget(tabId,action){return this.withTab(tabId,c=>this.describeTargetOn(c,action));}
  async readField(tabId,selector){return this.withTab(tabId,c=>this.readFieldOn(c,selector));}
  async setField(tabId,field,mode){return this.withTab(tabId,c=>this.setFieldOn(c,field,mode));}
  async perform(tabId,action,element={}){return this.withTab(tabId,c=>this.performOn(c,action,element));}
  async screenshot(tabId){return this.withTab(tabId,async c=>{
    const r=await c.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
    if(!r.data||r.data.length>2800000)throw new ControlError('SCREENSHOT_LIMIT','Screenshot too large',502);
    return {mimeType:'image/png',base64:r.data};
  });}
}
