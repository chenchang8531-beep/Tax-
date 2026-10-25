import test from 'node:test';
import assert from 'node:assert/strict';
import {HostAttestationGate,extractChromeProcessIdentity} from '../src/host-attestation.mjs';

const owner={listening:true,pid:3456,exe:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',commandLine:'"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\Users\\test\\Chrome Xero" --profile-directory="Profile 1"'};
const gate=probe=>new HostAttestationGate({expectedUserDataDir:'C:\\Users\\test\\Chrome Xero',expectedProfileDirectory:'Profile 1',port:9222,probe});
test('independently checks listening PID, process executable, exact user data and profile',async()=>{
 const g=gate(async()=>owner),r=await g.check(); assert.equal(r.attested,true);assert.equal(r.pid,3456);assert.match(r.fingerprint,/^[a-f0-9]{64}$/);assert.equal(r.commandLine,undefined);
 const allowed=await g.assertAllowed();assert.equal(allowed.pid,3456);
});
test('wrong profile, missing user-data-dir, changed PID and non-Chrome executable fail closed',async()=>{
 for(const bad of [{...owner,commandLine:owner.commandLine.replace('Profile 1','Profile 2')},{...owner,commandLine:owner.commandLine.replace(/ --user-data-dir="[^"]+"/,'')},{...owner,pid:0},{...owner,exe:'C:\\Windows\\System32\\cmd.exe'}]){
   const r=await gate(async()=>bad).check();assert.equal(r.attested,false);await assert.rejects(()=>gate(async()=>bad).assertAllowed(),e=>e.code==='PROFILE_NOT_ATTESTED');
 }
});
test('host attestation does not trust manually declared booleans or expose raw command line',async()=>{
 const r=await gate(async()=>({...owner,listening:false})).check();assert.equal(r.attested,false);
 const identity=extractChromeProcessIdentity(owner.commandLine);assert.equal(identity.userDataDir,'C:\\Users\\test\\Chrome Xero');assert.equal(identity.profileDirectory,'Profile 1');
 assert.equal(r.commandLine,undefined);
});
