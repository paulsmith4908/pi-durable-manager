import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PI_WORKER_POLICY } from "../src/worker-instructions.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { PiDurableService } from '../src/service.js';
import { startTerminalBrowser } from '../src/native-terminal-browser.js';
import { resolvePolicy, runSandboxedCommand } from '../src/sandbox.js';

async function fixture(){const dir=await mkdtemp(join(tmpdir(),'pdm-models-'));await mkdir(join(dir,'projects'));
 const faux=fauxProvider({provider:'faux',models:[{id:'legacy'}]}),models=createModels();models.setProvider(faux.provider);
 const config:any={configVersion:1,endpoint:'https://original.invalid/v1',model:'legacy',limits:{contextWindow:65536,maxTokens:8192,maxSteps:null,timeoutMs:null},paths:{stateDir:join(dir,'state'),projectHome:join(dir,'projects'),allowedRoots:[join(dir,'projects')]},credential:{env:'TEST_ONLY'},manager:{enabled:false}};
 const start=()=>PiDurableService.start({transport:'none',host:{config,createModels:()=>models,providerId:'faux',resolveCredential:async()=>({apiKey:'original-test-key',source:'test'}),unsandboxedForTesting:true}});let service=await start();
 const call=async(method:string,p:any={},requestId:string=randomUUID())=>{const r=await service.handle({v:1,id:requestId,method,params:{...p,requestId}});if(r.error)throw Object.assign(new Error(r.error.message),{code:r.error.code});return r.result as any;};
 const project=async(name:string)=>(await call('projects.create',{name,path:join(dir,'projects',name)})).project;
 const add=async(endpoint='http://127.0.0.1:1/v1')=>{const c=await call('models.connection.add',{name:'Local',endpoint,noAuth:true});return (await call('models.profile.add',{connectionId:c.connectionId,name:'Local model',model:'local-code',contextWindow:32768,maxTokens:4096})).profile;};
 return {dir,faux,call,project,add,metadata:()=>(service as any).metadata,agent:async(conversationId:string)=>{const conversation=await (service as any).harness.conversation(Number(conversationId),BACKGROUND_CONTEXT);return conversation.agent(BACKGROUND_CONTEXT);},restart:async()=>{await service.stop();service=await start();},close:async()=>{await service.stop();await rm(dir,{recursive:true,force:true});}};
}
test('defaults, project overrides and session pins survive restart; existing legacy model is unchanged',async()=>{const f=await fixture();try{
 const p=await f.project('old');await f.call('sessions.create',{projectId:p.id});const local=await f.add();
 await f.call('models.default',{profileId:local.id});assert.equal((await f.call('models.settings',{projectId:p.id})).projectProfileId,'existing');
 const next=await f.project('new');const session=(await f.call('sessions.create',{projectId:next.id})).session;
 const inspected=await f.call('sessions.inspect',{id:session.id});assert.match(JSON.stringify(inspected),/local-code/);
 await f.call('models.project',{projectId:next.id,profileId:'existing'});
 assert.match(JSON.stringify(await f.call('sessions.inspect',{id:session.id})),/local-code/);
 await f.restart();const settings=await f.call('models.settings',{projectId:next.id});assert.equal(settings.defaultProfileId,local.id);assert.equal(settings.projectProfileId,'existing');assert.equal(settings.connections[0].endpoint,'https://original.invalid/v1');
}finally{await f.close();}});
test('settings replay is idempotent, changed payload conflicts, credentials never appear in RPC/settings/activity',async()=>{const f=await fixture();try{
 const p={name:'Private',endpoint:'https://example.invalid/v1',apiKey:'private-fixture-1234'};
 const a=await f.call('models.connection.add',p,'same'),b=await f.call('models.connection.add',p,'same');assert.deepEqual(a,b);
 await assert.rejects(f.call('models.connection.add',{...p,apiKey:'different-key'},'same'),/changed/);
 const result=JSON.stringify(await f.call('models.settings'));assert.doesNotMatch(result,/private-fixture|apiKeyFile|"credential":/);
 assert.doesNotMatch(JSON.stringify(await f.call('activity.list')),/private-fixture/);
 const model={connectionId:a.connectionId,name:'Reasoner',model:'local',contextWindow:32000,maxTokens:4000,compat:{supportsStore:false}};
 await f.call('models.profile.add',model,'profile');await assert.rejects(f.call('models.profile.add',{...model,compat:{supportsStore:true}},'profile'),/changed/);
 await f.restart();assert.deepEqual(await f.call('models.connection.add',p,'same'),a);
}finally{await f.close();}});
test('unsafe endpoint and invalid limits are rejected; remote HTTP requires explicit opt-in',async()=>{const f=await fixture();try{
 for(const endpoint of ['https://user:pass@example.com/v1','https://example.com/v1?key=secret','file:///tmp/x','http://192.168.1.3:8080/v1'])await assert.rejects(f.call('models.connection.add',{name:'Bad',endpoint,noAuth:true}));
 const c=await f.call('models.connection.add',{name:'LAN',endpoint:'http://192.168.1.3:8080/v1',noAuth:true,allowInsecureHttp:true});
 await assert.rejects(f.call('models.profile.add',{connectionId:c.connectionId,name:'Bad',model:'x',contextWindow:1000,maxTokens:1000}),/smaller/);
 await assert.rejects(f.call('models.profile.add',{connectionId:c.connectionId,name:'Bad',model:'x',contextWindow:32000,maxTokens:1000,compat:{invented:true}}),/Unknown compat/);
}finally{await f.close();}});
test('a paused question keeps its project model; continuation still uses the original default',async()=>{const f=await fixture();try{
 const seen:string[]=[];
 const p=await f.project('worker'),w=(await f.call('workflow.open',{projectId:p.id,threadId:randomUUID(),objective:'Test',roadmap:'Ask then finish'})).workflow;
 f.faux.appendResponses([(context)=>{seen.push(JSON.stringify(context.messages.filter(m=>m.role==='system')));return fauxAssistantMessage(fauxToolCall('request_manager',{question:'Continue?',context:null}),{stopReason:'toolUse'});}]);
 const a=(await f.call('workflow.submit',{id:w.id,task:'Ask.',criteria:'Pause'})).assignment;await f.call('assignments.wait',{id:a.id,timeoutMs:10000});
 const local=await f.add();await f.call('models.default',{profileId:local.id});
 await assert.rejects(f.call('models.project',{projectId:p.id,profileId:local.id}),/Review or stop/);
 const e=(await f.call('workflow.status',{id:w.id})).events.find((e:any)=>e.kind==='manager_request');f.faux.appendResponses([(context)=>{seen.push(JSON.stringify(context.messages.filter(m=>m.role==='system')));return fauxAssistantMessage('Done');}]);
 const next=(await f.call('workflow.answer',{id:w.id,eventId:e.eventId,answer:'Yes'})).assignment;
 await f.call('assignments.wait',{id:next.id,timeoutMs:10000});assert.equal((await f.call('assignments.show',{id:next.id})).state,'needs_review');
 assert.equal((await f.call('models.settings',{projectId:p.id})).projectProfileId,'existing');
 assert.equal(seen.length,2);for(const prompt of seen){assert.ok(prompt.includes('pi-worker-policy'));assert.ok(prompt.includes('Effective operator permissions'));}
 await assert.rejects(readFile(join(p.path,'AGENTS.md'),'utf8'),{code:'ENOENT'});
}finally{await f.close();}});

async function wireFixture(coding=false,onRequest?:(body:any)=>Promise<void>){const requests:any[]=[];const server=createServer(async(req,res)=>{if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'local-code'}]}));return;}let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push({...body,authorization:req.headers.authorization});if(onRequest)await onRequest(body);const result=body.messages.find((m:any)=>m.role==='tool');const nonce=body.messages.find((m:any)=>m.role==='user').content.match(/[a-f0-9]{8}-[a-f0-9-]{27}/)?.[0];res.writeHead(200,{'Content-Type':'text/event-stream'});const delta=coding?(result?{role:'assistant',content:'Created proof.txt.'}:{role:'assistant',tool_calls:[{index:0,id:'write_1',type:'function',function:{name:'write',arguments:JSON.stringify({path:'proof.txt',content:'LOCAL_PROFILE_OK\n'})}}]}):result?{role:'assistant',content:result.content}:{role:'assistant',tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'readiness_echo',arguments:JSON.stringify({value:nonce})}}]};res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'local-code',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'local-code',choices:[{index:0,delta:{},finish_reason:result?'stop':'tool_calls'}]})}\n\n`);res.end('data: [DONE]\n\n');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return {requests,url:`http://127.0.0.1:${(server.address() as any).port}/v1`,close:()=>new Promise<void>(r=>server.close(()=>r()))};}
test('generic OpenAI-compatible streaming tool round trip and discovery use actual transport without DeepSeek assumptions',async()=>{const f=await fixture(),wire=await wireFixture();try{const p=await f.add(wire.url);assert.deepEqual((await f.call('models.discover',{connectionId:p.connectionId})).models,['local-code']);const result=await f.call('models.test',{profileId:p.id});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(wire.requests.length,2);assert.equal(wire.requests[0].stream,true);assert.equal(wire.requests[0].max_tokens,2048);assert.equal(wire.requests[0].reasoning_effort,undefined);assert.equal(wire.requests[1].messages.find((m:any)=>m.role==='assistant').reasoning_content,undefined);}finally{await wire.close();await f.close();}});
test('browser settings are narrow, same-origin and CSRF protected; ordinary viewer stays read-only',async()=>{const f=await fixture();const viewer=await startTerminalBrowser({stateDir:f.dir,rpc:{call:f.call}});try{
 const token=new URLSearchParams(new URL(viewer.operatorUrl).hash.slice(1)).get('operator')!;const authorization={Authorization:'Bearer '+token};
 assert.equal((await fetch(viewer.url+'/settings')).status,403);
 const publicText=await (await fetch(viewer.url+'/status')).text();assert.ok(!publicText.includes(token));
 const s=await (await fetch(viewer.url+'/settings',{headers:authorization})).json() as any;assert.ok(s.csrf);const body=JSON.stringify({action:'connection.add',params:{name:'Browser',endpoint:'http://localhost:9000/v1',noAuth:true,requestId:'browser'}});
 assert.equal((await fetch(viewer.url+'/settings',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);
 assert.equal((await fetch(viewer.url+'/settings',{method:'POST',headers:{...authorization,'Content-Type':'application/json',Origin:'https://evil.invalid','X-Pi-Settings':s.csrf},body})).status,403);
 assert.equal((await fetch(viewer.url+'/settings',{method:'POST',headers:{...authorization,'Content-Type':'application/json',Origin:viewer.url,'X-Pi-Settings':s.csrf},body})).status,200);
 assert.equal((await fetch(viewer.url+'/settings',{method:'POST',headers:{...authorization,'Content-Type':'application/json',Origin:viewer.url,'X-Pi-Settings':s.csrf},body:JSON.stringify({action:'assignments.submit',params:{}})})).status,400);
 assert.equal((await fetch(viewer.url+'/events',{method:'POST'})).status,405);
}finally{await viewer.close();await f.close();}});
test('real Chrome Settings tab adds a connection/profile and selects default and project without starting a worker',async()=>{
 const f=await fixture();const p=await f.project('browser'),w=(await f.call('workflow.open',{projectId:p.id,threadId:randomUUID(),objective:'Settings acceptance',roadmap:'No worker'})).workflow;
 const viewer=await startTerminalBrowser({stateDir:f.dir,rpc:{call:f.call}});const {chromium}=await import('playwright-core');let browser:any;
 try{browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const page=await browser.newPage({viewport:{width:700,height:850}});page.setDefaultTimeout(10000);const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));const operator=new URL(viewer.operatorUrl);operator.searchParams.set('workflowId',w.id);operator.hash+='&view=settings';await page.goto(operator.href);assert.ok(!page.url().includes('operator='));
 await page.locator('#profile-connection option').first().waitFor({state:'attached'});assert.equal(await page.locator('#settings-panel').isVisible(),true);
 assert.equal(await page.locator('#connection-form').isVisible(),false);assert.equal(await page.locator('#profile-form').isVisible(),false);await page.locator('#add-model > summary').click();await page.locator('#add-provider > summary').click();await page.locator('#connection-form [name=name]').fill('Local browser fixture');await page.locator('#connection-form [name=endpoint]').fill('http://127.0.0.1:8089/v1');await page.locator('#connection-form [name=noAuth]').check();await page.getByRole('button',{name:'Save provider',exact:true}).click();await page.waitForFunction(()=>(globalThis as any).document.querySelector('#settings-message')?.textContent?.includes('Provider saved'));
 const c=(await f.call('models.settings')).connections.find((c:any)=>c.name==='Local browser fixture');assert.equal(await page.locator('#profile-connection').inputValue(),c.id);assert.equal(await page.locator('#connection-form').isVisible(),false);await page.locator('#profile-form [name=name]').fill('Browser model');await page.locator('#profile-form [name=model]').fill('fixture-code');await page.locator('#profile-form [name=contextWindow]').fill('32768');await page.locator('#profile-form [name=maxTokens]').fill('4096');await page.getByRole('button',{name:'Save model',exact:true}).click();await page.waitForFunction(()=>(globalThis as any).document.querySelector('#settings-message')?.textContent?.includes('Model saved'));
 const profile=(await f.call('models.settings')).profiles.find((p:any)=>p.name==='Browser model');await page.locator('#model-default').selectOption(profile.id);await page.getByRole('button',{name:'Save default',exact:true}).click();await page.waitForFunction(()=>(globalThis as any).document.querySelector('#settings-message')?.textContent?.includes('Default saved'));
 await page.locator('#model-project').selectOption(profile.id);await page.getByRole('button',{name:'Save choice',exact:true}).click();await page.waitForFunction(()=>(globalThis as any).document.querySelector('#settings-message')?.textContent?.includes('Project model saved'));
 await page.reload();await page.locator('#profile-connection option').first().waitFor({state:'attached'});assert.equal(await page.locator('#model-project').inputValue(),profile.id);assert.equal((await f.call('assignments.list')).assignments.length,0);assert.deepEqual(errors,[]);
 await page.getByRole('tab',{name:'Progress',exact:true}).click();assert.equal(await page.locator('#settings-panel').isVisible(),false);
 }finally{await browser?.close();await viewer.close();await f.close();}
});

test('an explicit profile drives a real worker tool call, evidence and session usage through the generic endpoint',async()=>{const f=await fixture(),wire=await wireFixture(true);try{const p=await f.project('generic-code'),profile=await f.add(wire.url);const w=(await f.call('workflow.open',{projectId:p.id,threadId:randomUUID(),objective:'Write proof',roadmap:'Create and review proof.txt'})).workflow;const a=(await f.call('workflow.submit',{id:w.id,task:'Write proof.txt containing LOCAL_PROFILE_OK followed by newline.',criteria:'Exact file',profileId:profile.id})).assignment;await f.call('assignments.wait',{id:a.id,timeoutMs:10000});assert.equal((await f.call('assignments.show',{id:a.id})).state,'needs_review');assert.equal(await readFile(join(p.path,'proof.txt'),'utf8'),'LOCAL_PROFILE_OK\n');assert.equal((await f.call('sessions.inspect',{id:a.sessionId})).model.modelId,'local-code');assert.equal(wire.requests.length,2);const e=await f.call('assignments.evidence',{id:a.id});assert.ok(JSON.stringify(e).includes('proof.txt'));}finally{await wire.close();await f.close();}});

 test('custom session instructions retain worker scope without changing the repo guidance',async()=>{const f=await fixture();try{
 const p=await f.project('instruction-scope');const before=await readFile(join(p.path,'AGENTS.md'),'utf8').catch(()=>null);
 const session=(await f.call('sessions.create',{projectId:p.id})).session;
 await f.call('sessions.configure',{id:session.id,instructions:'Write a concise report for this test.'});
 const transcript=JSON.stringify(await f.agent(session.conversationId));
 assert.ok(transcript.includes('pi-worker-policy'));assert.ok(transcript.includes('Write a concise report for this test.'));
 assert.equal(await readFile(join(p.path,'AGENTS.md'),'utf8').catch(()=>null),before);
}finally{await f.close();}});


test('network-enabled sandbox cannot obtain operator authority or mutate settings', {skip:process.platform!=='darwin'}, async()=>{
 const f=await fixture(),viewer=await startTerminalBrowser({stateDir:f.dir,rpc:{call:f.call}});
 try {
  const root=join(f.dir,'network-worker');await mkdir(root);
  const policy=resolvePolicy({root,allowNetwork:true,protectedPaths:[join(f.dir,'state')],timeoutMs:10000});
  const before=(await f.call('models.settings')).defaultProfileId;
  const get=await runSandboxedCommand(policy,`/usr/bin/curl --max-time 5 -sS -o /dev/null -w '%{http_code}' '${viewer.url}/settings'`);
  assert.equal(get.exitCode,0);assert.equal(get.stdout,'403');
  // Even disclosing the CSRF value to this test worker cannot replace operator authentication.
  const token=new URLSearchParams(new URL(viewer.operatorUrl).hash.slice(1)).get('operator');
  const settings=await (await fetch(viewer.url+'/settings',{headers:{Authorization:'Bearer '+token}})).json() as any;
  const post=await runSandboxedCommand(policy,`/usr/bin/curl --max-time 5 -sS -o /dev/null -w '%{http_code}' -X POST -H 'Origin: ${viewer.url}' -H 'Content-Type: application/json' -H 'X-Pi-Settings: ${settings.csrf}' --data '{"action":"default","params":{"profileId":"fake","requestId":"worker-attempt"}}' '${viewer.url}/settings'`);
  assert.equal(post.exitCode,0);assert.equal(post.stdout,'403');
  assert.equal((await f.call('models.settings')).defaultProfileId,before);
 }finally{await viewer.close();await f.close();}
});

test('compact session model identity stays pinned when the default changes', async()=>{const f=await fixture();try{
 const p=await f.project('identity'),local=await f.add();
 const session=(await f.call('sessions.create',{projectId:p.id,profileId:local.id})).session;
 await f.call('models.default',{profileId:'existing'});
 const identity=await f.call('sessions.model',{id:session.id});
 assert.equal(identity.model.modelId,'local-code');assert.equal(identity.profileName,'Local model');assert.equal(identity.providerName,'Local');assert.equal(identity.profileId,local.id);
 assert.equal((await f.call('service.status')).model,'legacy');
 assert.ok(!('entries'in identity));assert.ok(!('endpoint'in identity));assert.ok(!('credential'in identity));
 await f.restart();assert.deepEqual(await f.call('sessions.model',{id:session.id}),identity);
}finally{await f.close();}});


test('added connection credential rotation is private, replayable, restart-safe and revocable',async()=>{
 const f=await fixture(),wire=await wireFixture();try{
  const c=await f.call('models.connection.add',{name:'Rotatable',endpoint:wire.url,apiKey:'fake-old-private-key'});
  const profile=(await f.call('models.profile.add',{connectionId:c.connectionId,name:'Rotatable model',model:'local-code',contextWindow:32768,maxTokens:4096})).profile;
  const rotated=await f.call('models.connection.rotate',{connectionId:c.connectionId,apiKey:'fake-new-private-key'},'rotation');
  assert.deepEqual(await f.call('models.connection.rotate',{connectionId:c.connectionId,apiKey:'fake-new-private-key'},'rotation'),rotated);
  assert.equal(rotated.credentialRevision,2);
  await f.restart();assert.equal((await f.call('models.test',{profileId:profile.id})).ok,true);
  assert.equal(wire.requests[0].authorization,'Bearer fake-new-private-key');
  const publicData=JSON.stringify([await f.call('models.settings'),await f.call('activity.list')]);assert.doesNotMatch(publicData,/fake-new-private-key|fake-old-private-key/);
  await f.call('models.connection.rename',{connectionId:c.connectionId,name:'Renamed'});
  assert.equal((await f.call('models.settings')).connections.find((x:any)=>x.id===c.connectionId).name,'Renamed');
  await f.call('models.connection.disable',{connectionId:c.connectionId});
  await f.restart();await assert.rejects(f.call('models.test',{profileId:profile.id}),/disabled/);
  await assert.rejects(f.call('models.default',{profileId:profile.id}),/disabled/);
  await assert.rejects(f.call('models.connection.rotate',{connectionId:'existing',apiKey:'fake'}),/original connection/);
 }finally{await wire.close();await f.close();}
});


test('short dummy credentials do not rewrite configuration, exclusions or immutable assignment policy',async()=>{
 const f=await fixture();try{
  const c=await f.call('models.connection.add',{name:'local provider',endpoint:'http://localhost:8080/v1',apiKey:'local'});
  const profile=(await f.call('models.profile.add',{connectionId:c.connectionId,name:'local model',model:'local-code',contextWindow:32000,maxTokens:4000})).profile;
  const p=await f.project('local-project'),current=await f.call('permissions.read',{projectId:p.id});
  const policy={...current.policy,excludedPaths:['local-private']};
  await f.call('permissions.set',{projectId:p.id,expectedRevision:current.revision,policy});
  await f.call('models.connection.rotate',{connectionId:c.connectionId,apiKey:'model'});
  await f.restart();const settings=await f.call('models.settings');
  assert.equal(settings.connections.find((x:any)=>x.id===c.connectionId).endpoint,'http://localhost:8080/v1');
  assert.equal(settings.profiles.find((x:any)=>x.id===profile.id).name,'local model');
  assert.deepEqual((await f.call('permissions.read',{projectId:p.id})).policy.excludedPaths,['local-private']);
  f.faux.appendResponses([fauxAssistantMessage('No edits')]);
  const a=(await f.call('assignments.submit',{projectId:p.id,task:'Observe only',acceptanceCriteria:'No edits'})).assignment;
  await f.call('assignments.wait',{id:a.id,timeoutMs:10000});
  assert.deepEqual((await f.call('permissions.read',{projectId:p.id,assignmentId:a.id})).assignment.policy.excludedPaths,['local-private']);
 }finally{await f.close();}
});

test('credential staging recovers precommit crashes, preserves committed keys and retries failed cleanup',async()=>{
 const f=await fixture();try{
  const c=await f.call('models.connection.add',{name:'Recovery',endpoint:'http://localhost:1/v1',apiKey:'fake-old'});
  const dir=join(f.dir,'state','model-credentials'),active=(await readdir(dir))[0]!,orphan=join(dir,randomUUID()+'.key');
  await writeFile(orphan,'fake-orphan',{mode:0o600});
  f.metadata().setPrivateConfiguration('workflow-credential-cleanup',[orphan,join(dir,active)]);
  await f.restart();assert.deepEqual(await readdir(dir),[active]);
  // Simulate an OS refusal to delete the previous owned key. No secret is read.
  await rm(join(dir,active));await mkdir(join(dir,active));
  const params={connectionId:c.connectionId,apiKey:'fake-new'};
  const rotation=await f.call('models.connection.rotate',params,'cleanup-retry');
  assert.equal((await f.call('models.settings')).credentialCleanupPending,1);
  await rm(join(dir,active),{recursive:true});
  assert.deepEqual(await f.call('models.connection.rotate',params,'cleanup-retry'),rotation);
  assert.equal((await f.call('models.settings')).credentialCleanupPending,0);
  assert.equal((await readdir(dir)).length,1);
 }finally{await f.close();}
});

test('rotation invalidates readiness including an in-flight check; revocation keeps historical model identity',async()=>{
 const f=await fixture();let release!:()=>void,reached!:()=>void;
 const requestSeen=new Promise<void>(r=>reached=r),gate=new Promise<void>(r=>release=r);let block=false;
 const wire=await wireFixture(false,async()=>{if(block){block=false;reached();await gate;}});
 try{
  const c=await f.call('models.connection.add',{name:'Lifecycle',endpoint:wire.url,apiKey:'fake-key-one'});
  const profile=(await f.call('models.profile.add',{connectionId:c.connectionId,name:'Lifecycle model',model:'local-code',contextWindow:32768,maxTokens:4096})).profile;
  const p=await f.project('historical'),session=(await f.call('sessions.create',{projectId:p.id,profileId:profile.id})).session;
  assert.equal((await f.call('models.test',{profileId:profile.id})).ok,true);
  block=true;const checking=f.call('models.test',{profileId:profile.id});await requestSeen;
  await f.call('models.connection.rotate',{connectionId:c.connectionId,apiKey:'fake-key-two'});
  release();assert.equal((await checking).stale,true);
  assert.equal((await f.call('models.settings')).profiles.find((x:any)=>x.id===profile.id).lastTest,null);
  await f.call('models.connection.disable',{connectionId:c.connectionId});
  const identity=await f.call('sessions.model',{id:session.id});assert.equal(identity.model.modelId,'local-code');assert.equal(identity.available,false);
  assert.equal((await f.call('sessions.inspect',{id:session.id})).model.modelId,'local-code');
 }finally{release?.();await wire.close();await f.close();}
});
