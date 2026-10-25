import { createHash, timingSafeEqual } from 'node:crypto';

export class ControlError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const sha256 = input => createHash('sha256').update(input).digest('hex');
export function constantTimeTokenMatch(expected, received) {
  if (!expected || !received) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
export function allowedUrl(address, { localTests = false } = {}) {
  let url;
  try { url = new URL(address); } catch { return false; }
  if (localTests && url.href === 'about:blank') return true;
  if (localTests && ['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:') return true;
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'xero.com' || host.endsWith('.xero.com') || host === 'xero.com.au' || host.endsWith('.xero.com.au');
}
// A conservative blocklist: it is not a substitute for actual user approval or Xero native safeguards.
const DANGEROUS = /\b(lodge|lodgement|submit|file\s+(?:return|bas|tax)|sign|approve|authori[sz]e|publish|post\s+(?:pay\s*run|payroll)|pay\s+(?:now|invoice)|transfer\s+funds|bank\s+transfer|delete|remove\s+(?:client|account|return)|void|finali[sz]e|send\s+(?:email|message|return)|terminate|discard|irreversible)\b/i;
const BLOCKED_KEYS = new Set(['F5', 'Control+R', 'Meta+R']);
export function validateAction(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new ControlError('BAD_ACTION', 'Action must be an object');
  const valid = ['click','double_click','hover','drag','type','scroll','press','select','wait','navigate'];
  if (!valid.includes(a.kind)) throw new ControlError('BAD_ACTION', 'Unsupported action kind');
  if (a.selector !== undefined && (typeof a.selector !== 'string' || !a.selector || a.selector.length > 400)) throw new ControlError('BAD_SELECTOR', 'Selector must be 1-400 characters');
  if (['click','double_click','hover'].includes(a.kind)) {
    if (!a.selector && (!Number.isFinite(a.x) || !Number.isFinite(a.y))) throw new ControlError('BAD_ACTION', 'Click needs a selector or x/y');
  }
  if(a.kind === 'drag' && (![a.x,a.y,a.toX,a.toY].every(Number.isFinite) || Math.hypot(a.toX-a.x,a.toY-a.y)>1500)) throw new ControlError('BAD_DRAG','Drag requires bounded start/end coordinates');
  if (a.kind === 'type' && (!a.selector || typeof a.text !== 'string' || a.text.length > 4096)) throw new ControlError('BAD_ACTION', 'Type requires selector and <=4096 characters');
  if (a.kind === 'scroll' && (!Number.isFinite(a.deltaY) || Math.abs(a.deltaY) > 1200)) throw new ControlError('BAD_ACTION', 'Scroll deltaY must be within +/-1200');
  if (a.kind === 'press' && (!a.selector || !['Tab','Escape','Backspace','Delete','Enter','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(a.key))) throw new ControlError('BAD_ACTION', 'Unsafe or unsupported key');
  if (a.kind === 'select' && (!a.selector || typeof a.value !== 'string' || a.value.length > 500)) throw new ControlError('BAD_ACTION', 'Select requires selector and value');
  if (a.kind === 'wait' && (!Number.isInteger(a.ms) || a.ms < 100 || a.ms > 5000)) throw new ControlError('BAD_ACTION', 'Wait requires 100..5000 ms');
  if (a.kind === 'navigate' && typeof a.url !== 'string') throw new ControlError('BAD_ACTION', 'Navigate requires URL');
  return a;
}
export function riskGuard(action, element = {}) {
  const label = [element.label, element.text, element.title, element.ariaLabel, element.href,
    ...(['click','double_click','press','select','drag'].includes(action.kind)?[element.formAction]:[])].filter(Boolean).join(' ');
  if (DANGEROUS.test(label)) throw new ControlError('IRREVERSIBLE_BLOCKED', 'High-risk control is blocked; requires separate authorized workflow', 403);
  if (element.pointerOccluded) throw new ControlError('TARGET_OCCLUDED', 'Another control is covering the intended browser target', 409);
  if (element.password || element.type === 'password' || element.isEditableSecret) throw new ControlError('CREDENTIAL_BLOCKED', 'Credential fields are not operated by this plugin', 403);
  if (action.kind === 'press' && action.key === 'Enter' && element.inForm) throw new ControlError('FORM_SUBMIT_KEY_BLOCKED','Enter may submit the entire form; use an explicitly identified control',403);
  if (action.kind === 'press' && BLOCKED_KEYS.has(action.key)) throw new ControlError('BLOCKED_KEY', 'Unapproved browser key', 403);
  if (action.kind === 'navigate' && DANGEROUS.test(new URL(action.url).pathname.replaceAll('/', ' '))) throw new ControlError('IRREVERSIBLE_BLOCKED', 'High-risk navigation blocked', 403);
  if ((['click','double_click','press','drag'].includes(action.kind)) && !label.trim()) throw new ControlError('UNKNOWN_TARGET', 'Target has no inspectable label', 403);
}
export function snapshotRevision(s) {
  const data = {url:s.url,title:s.title,visibleText:s.visibleText,controls:s.controls,viewport:s.viewport};
  return sha256(JSON.stringify(data));
}
export function requireExactScope(scope) {
  if (!scope || typeof scope !== 'object') throw new ControlError('SCOPE_REQUIRED','Exact scope is required');
  for(const name of ['project','entity','period','matter']) {
    if (typeof scope[name] !== 'string' || scope[name].trim().length < 2 || scope[name].length > 160) throw new ControlError('SCOPE_REQUIRED',`Exact ${name} is required`);
  }
  return Object.freeze({project:scope.project,entity:scope.entity,period:scope.period,matter:scope.matter});
}

// A no-dangerous-keyword check is insufficient: generic OK/Confirm/Continue buttons
// may be irreversible. Production UI acts only on these bounded Draft-phase intents.
export function draftActionAllowlist(action,element={}){
 const kind=action.kind;
 if(['wait','scroll','hover'].includes(kind))return true;
 if(kind==='navigate'){if(!allowedUrl(action.url))throw new ControlError('DRAFT_ACTION_UNCLASSIFIED','Navigation outside allowed Xero context',403);return true;}
 if(kind==='select'){if(element.tag!=='SELECT')throw new ControlError('DRAFT_ACTION_UNCLASSIFIED','Only native labeled Select controls allowed',403);return true;}
 if(kind==='press'){
  if(!['Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(action.key))throw new ControlError('DRAFT_ACTION_UNCLASSIFIED','Unclassified keyboard mutation',403);
  return true;
 }
 if(['click','double_click'].includes(kind)){
  if(element.tag==='A'&&allowedUrl(element.href))return true;
  const label=String(element.label||'').trim().toLocaleLowerCase();
  if(element.tag==='BUTTON'&&/^(save(?: draft| changes)?|next|back|previous|edit|view|expand|collapse|show details|hide details|add worksheet)$/i.test(label))return true;
  throw new ControlError('DRAFT_ACTION_UNCLASSIFIED','Only explicitly classified Draft edit/navigation controls may be clicked',403);
 }
 if(kind==='drag')throw new ControlError('DRAFT_ACTION_UNCLASSIFIED','Unknown drag effects are not authorised on a tax form',403);
 return false;
}
