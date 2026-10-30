import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetadataStore} from '../src/store.js';
import {ManagerWakeCoordinator} from '../src/manager-coordinator.js';
import {ManagerDispatcher} from '../src/manager-dispatcher.js';

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'pi-queue-retirement-'));
 const store=await MetadataStore.open(join(dir,'state.sqlite'));
 store.insertProject({id:'p',name:'test',path:dir,origin:'created',requestId:'p',createdAt:1,updatedAt:1});
 store.upsertManagerBinding({projectId:'p',threadId:'t',requestId:'b',createdAt:1,updatedAt:1});
 const queue=new Set(['user-message']);const deleted:string[]=[];
 const dispatcher=new ManagerDispatcher({executable:'fixture',exec:async()=>({stdout:'Queued message pi-receipt for thread t.',stderr:'',code:0}),retract:async(_t,id)=>{deleted.push(id);return {deleted:queue.delete(id)};}});
 const manager=new ManagerWakeCoordinator({metadata:store,dispatcher,enabled:false});
 const event=(assignmentId:string)=>manager.recordTransition({projectId:'p',assignmentId,conversationId:null,state:'blocked',prevState:'running',kind:'manager_request'})!;
 const deliver=(id:string,receipt='pi-receipt')=>{queue.add(receipt);store.updateManagerEventDelivery(id,{deliveryState:'delivered',receipt,threadId:'t',nextAttemptAt:null});};
 return {dir,store,queue,deleted,dispatcher,manager,event,deliver,close:async()=>{await manager.stop();await store.close();await rm(dir,{recursive:true,force:true});}};
}
test('cleanup removes acknowledged Pi receipt, preserves user messages, and replays without another deletion',async()=>{
 const f=await fixture();try{
  const id=f.event('a');f.deliver(id);f.store.ackManagerEvent(id,Date.now());
  await f.manager.reconcileQueued();await f.manager.reconcileQueued();
  assert.deepEqual([...f.queue],['user-message']);assert.deepEqual(f.deleted,['pi-receipt']);
  assert.equal(f.store.getControl<any>('workflow-queue:pi-receipt').state,'removed');
 }finally{await f.close();}
});
test('coalesced receipt remains until every event in the batch is handled',async()=>{
 const f=await fixture();try{
  const a=f.event('a'),b=f.event('b');f.deliver(a);f.deliver(b);f.store.ackManagerEvent(a,1);
  await f.manager.reconcileQueued();assert.equal(f.deleted.length,0);
  f.store.ackManagerEvent(b,2);await f.manager.reconcileQueued();assert.deepEqual(f.deleted,['pi-receipt']);
 }finally{await f.close();}
});
test('unbinding retires queued wakes without acknowledging unreviewed work',async()=>{
 const f=await fixture();try{
  const id=f.event('a');f.deliver(id);f.store.deleteManagerBinding('p');
  await f.manager.reconcileQueued();assert.equal(f.queue.has('pi-receipt'),false);
  assert.equal(f.store.getManagerEvent(id)!.acked,false);
 }finally{await f.close();}
});
test('failed removal is durable and does not pretend the queued message disappeared',async()=>{
 const f=await fixture();try{
  const id=f.event('a');f.deliver(id);f.store.ackManagerEvent(id,1);
  const dispatcher=new ManagerDispatcher({executable:'fixture',retract:async()=>{throw Error('offline')}});
  const m=new ManagerWakeCoordinator({metadata:f.store,dispatcher,enabled:false,maxAttempts:1});
  await m.reconcileQueued();assert.equal(f.store.getControl<any>('workflow-queue:pi-receipt').state,'error');
  assert.equal(f.store.getControl<any>('manager-queue-cleanup').failed,1);assert.equal(f.queue.has('pi-receipt'),true);
  await m.stop();
 }finally{await f.close();}
});
test('restart recovers recorded receipts after event receipt was replaced by a reminder',async()=>{
 const f=await fixture();try{
  const id=f.event('a');f.deliver(id);await f.manager.reconcileQueued(); // saves first receipt
  f.deliver(id,'reminder-receipt');f.store.ackManagerEvent(id,1);
  const m=new ManagerWakeCoordinator({metadata:f.store,dispatcher:f.dispatcher,enabled:false});
  await m.reconcileQueued();assert.deepEqual([...f.queue],['user-message']);
  assert.deepEqual(f.deleted.sort(),['pi-receipt','reminder-receipt']);await m.stop();
 }finally{await f.close();}
});
test('acknowledgment during in-flight queue delivery removes late receipt immediately',async()=>{
 const f=await fixture();let dispatchStarted!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>dispatchStarted=r);const barrier=new Promise<void>(r=>release=r);
 const dispatcher=new ManagerDispatcher({executable:'fixture',exec:async()=>{dispatchStarted();await barrier;f.queue.add('race-receipt');return {stdout:'Queued message race-receipt for thread t.',stderr:'',code:0};},retract:async(_t,id)=>({deleted:f.queue.delete(id)})});
 const m=new ManagerWakeCoordinator({metadata:f.store,dispatcher,coalesceMs:0});
 try{
  const id=m.recordTransition({projectId:'p',assignmentId:'race',conversationId:null,state:'blocked',prevState:'running',kind:'manager_request'})!;
  await started;f.store.ackManagerEvent(id,1);await m.reconcileQueued();release();
  for(let i=0;i<100&&!f.store.getControl<any>('workflow-queue:race-receipt');i++)await new Promise(r=>setTimeout(r,5));
  await m.reconcileQueued();assert.equal(f.queue.has('race-receipt'),false);
  assert.equal(f.store.getControl<any>('workflow-queue:race-receipt').state,'removed');
 }finally{release();await m.stop();await f.close();}
});
