import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ControlError,sha256} from './safety.mjs';

const execFileAsync=promisify(execFile);
const psScript=fileURLToPath(new URL('../scripts/inspect-chrome-owner.ps1',import.meta.url));
function normalizeDir(s){if(typeof s!=='string'||!s.trim())return null;return win32.normalize(s.trim().replace(/[\\/]+$/,'')).toLowerCase();}
function takeSwitch(line,flag){
 if(typeof line!=='string')return null;
 const pattern=new RegExp('(?:^|\\s)--'+flag+'=(?:"([^"]+)"|(\\S+))','i');
 const m=line.match(pattern);return m?(m[1]??m[2]).trim():null;
}
export function extractChromeProcessIdentity(commandLine){
 return {userDataDir:takeSwitch(commandLine,'user-data-dir'),profileDirectory:takeSwitch(commandLine,'profile-directory')};
}
export async function readWindowsChromeOwner(port=9222){
 if(process.platform!=='win32')throw new ControlError('HOST_NOT_WINDOWS','Windows process ownership requires actual Windows execution',503);
 const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',psScript,'-Port',String(port)],{timeout:6000,maxBuffer:16000,windowsHide:true});
 let observation;try{observation=JSON.parse(stdout.trim());}catch{throw new ControlError('OWNER_PROBE_INVALID','Windows process probe returned invalid structured output',502);}
 return observation;
}
export class HostAttestationGate{
 constructor({expectedUserDataDir,expectedProfileDirectory,expectedExecutablePath,port=9222,probe=readWindowsChromeOwner,now=Date.now}={}){
   this.expectedUserDataDir=normalizeDir(expectedUserDataDir);this.expectedProfileDirectory=expectedProfileDirectory?.trim()||null;
   this.expectedExecutablePath=normalizeDir(expectedExecutablePath);this.port=port;this.probe=probe;this.now=now;
 }
 async check(){
  const observedAt=new Date(this.now()).toISOString();
  if(!this.expectedUserDataDir)return {attested:false,reason:'EXPECTED_PROFILE_UNSET',observedAt};
  try{
   const obj=await this.probe(this.port);
   if(!obj||obj.listening!==true||!Number.isSafeInteger(obj.pid)||obj.pid<=0)return {attested:false,reason:'OWNER_UNVERIFIED',observedAt};
   if(typeof obj.exe!=='string'||win32.basename(obj.exe).toLowerCase()!=='chrome.exe')return {attested:false,reason:'NOT_CHROME',observedAt};
   const ident={...extractChromeProcessIdentity(obj.commandLine),userDataDir:obj.userDataDir??extractChromeProcessIdentity(obj.commandLine).userDataDir,profileDirectory:obj.profileDirectory??extractChromeProcessIdentity(obj.commandLine).profileDirectory};
   if(normalizeDir(ident.userDataDir)!==this.expectedUserDataDir)return {attested:false,reason:'PROFILE_MISMATCH',observedAt};
   if(this.expectedProfileDirectory&&ident.profileDirectory!==this.expectedProfileDirectory)return {attested:false,reason:'PROFILE_DIRECTORY_MISMATCH',observedAt};
   if(this.expectedExecutablePath&&normalizeDir(obj.exe)!==this.expectedExecutablePath)return {attested:false,reason:'EXECUTABLE_MISMATCH',observedAt};
   return {attested:true,reason:'CURRENT_WINDOWS_PROCESS_MATCH',pid:obj.pid,observedAt,
      fingerprint:sha256(JSON.stringify({pid:obj.pid,exe:normalizeDir(obj.exe),userDataDir:this.expectedUserDataDir,profileDirectory:ident.profileDirectory,port:this.port}))};
  }catch(e){return {attested:false,reason:e?.code==='HOST_NOT_WINDOWS'?'HOST_NOT_WINDOWS':'WINDOWS_OWNER_PROBE_FAILED',observedAt};}
 }
 async assertAllowed(){const r=await this.check();if(!r.attested)throw new ControlError('PROFILE_NOT_ATTESTED',`Current Windows Chrome owner/profile is not verified (${r.reason})`,403);return r;}
}
