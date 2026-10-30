import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
async function start(dir:string){
 const child=fork(new URL('./fixtures/recovery-service.js',import.meta.url),[dir],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr?.on('data',x=>stderr+=x);
 const waiting=new Map<string,{resolve:(x:any)=>void,reject:(e:Error)=>void}>();
 let readyResolve:()=>void,readyReject:(e:Error)=>void;const ready=new Promise<void>((r,j)=>{readyResolve=r;readyReject=j;});
 child.on('message',(m:any)=>{if(m.ready){readyResolve();return;}const p=waiting.get(m.id);if(!p)return;waiting.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});
 child.on('exit',()=>{const e=Error('Fixture daemon exited: '+stderr.slice(-3000));readyReject(e);for(const p of waiting.values())p.reject(e);waiting.clear();});
 await ready;
 return {child,call:(method:string,params:any={},id=randomUUID())=>new Promise<any>((resolve,reject)=>{waiting.set(id,{resolve,reject});child.send({id,method,params});})};
}
test('actual SIGKILL during a command quarantines after restart and never replays the side effect',{timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pdm-real-crash-'));await mkdir(join(dir,'projects'));let daemon=await start(dir);
 try{
  const project=(await daemon.call('projects.create',{path:join(dir,'projects','sample'),name:'crash-test'})).project;
  const session=(await daemon.call('sessions.create',{projectId:project.id})).session;
  const a=(await daemon.call('assignments.submit',{projectId:project.id,sessionId:session.id,task:'Append once then finish.',criteria:'One append'})).assignment;
  const marker=join(project.path,'crash-marker.txt');const deadline=Date.now()+5000;
  while(await readFile(marker,'utf8').catch(()=>null)!=='once\n'){if(Date.now()>deadline)throw Error('Command never started');await new Promise(r=>setTimeout(r,10));}
  const died=once(daemon.child,'exit');daemon.child.kill('SIGKILL');await died;
  daemon=await start(dir);
  const blocked=await daemon.call('assignments.show',{id:a.id});
  assert.equal(blocked.state,'blocked');assert.match(blocked.stopReason,/quarantine|in_doubt|crash/);
  await new Promise(r=>setTimeout(r,250));assert.equal(await readFile(marker,'utf8'),'once\n');
  assert.equal((await daemon.call('assignments.list')).assignments.length,1);
  await assert.rejects(daemon.call('assignments.pause',{id:a.id,note:'Cannot treat quarantine as a pause'}),/Only a running/);
  const cp=await daemon.call('assignments.checkpoint',{id:a.id});assert.equal(cp.verified,true);
  await daemon.call('assignments.cancel',{id:a.id});
  assert.equal((await daemon.call('assignments.show',{id:a.id})).state,'cancelled');
 }finally{
  if(daemon.child.exitCode===null&&daemon.child.signalCode===null){await daemon.call('fixture.stop');}
  await rm(dir,{recursive:true,force:true});
 }
});
