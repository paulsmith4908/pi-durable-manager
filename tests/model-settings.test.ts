import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { PiDurableService } from '../src/service.js';
import { startTerminalBrowser } from '../src/native-terminal-browser.js';

async function fixture(){const dir=await mkdtemp(join(tmpdir(),'pdm-models-'));await mkdir(join(dir,'projects'));
 const faux=fauxProvider({provider:'faux',models:[{id:'legacy'}]}),models=createModels();models.setProvider(faux.provider);
 const config:any={configVersion:1,endpoint:'https://original.invalid/v1',model:'legacy',limits:{contextWindow:65536,maxTokens:8192,maxSteps:null,timeoutMs:null},paths:{stateDir:join(dir,'state'),projectHome:join(dir,'projects'),allowedRoots:[join(dir,'projects')]},credential:{env:'TEST_ONLY'},manager:{enabled:false}};
 const start=()=>PiDurableService.start({transport:'none',host:{config,createModels:()=>models,providerId:'faux',resolveCredential:async()=>({apiKey:'original-test-key',source:'test'}),unsandboxedForTesting:true}});let service=await start();
 const call=async(method:string,p:any={},requestId:string=randomUUID())=>{const r=await service.handle({v:1,id:requestId,method,params:{...p,requestId}});if(r.error)throw Object.assign(new Error(r.error.message),{code:r.error.code});return r.result as any;};
 const project=async(name:string)=>(await call('projects.create',{name,path:join(dir,'projects',name)})).project;
 const add=async(endpoint='http://127.0.0.1:1/v1')=>{const c=await call('models.connection.add',{name:'Local',endpoint,noAuth:true});return (await call('models.profile.add',{connectionId:c.connectionId,name:'Local model',model:'local-code',contextWindow:32768,maxTokens:4096})).profile;};
 return {dir,faux,call,project,add,restart:async()=>{await service.stop();service=await start();},close:async()=>{await service.stop();await rm(dir,{recursive:true,force:true});}};
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
 const result=JSON.stringify(await f.call('models.settings'));assert.doesNotMatch(result,/private-fixture|apiKeyFile|credential/);
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
 const p=await f.project('worker'),w=(await f.call('workflow.open',{projectId:p.id,threadId:randomUUID(),objective:'Test',roadmap:'Ask then finish'})).workflow;
 f.faux.appendResponses([fauxAssistantMessage(fauxToolCall('request_manager',{question:'Continue?',context:null}),{stopReason:'toolUse'})]);
 const a=(await f.call('workflow.submit',{id:w.id,task:'Ask.',criteria:'Pause'})).assignment;await f.call('assignments.wait',{id:a.id,timeoutMs:10000});
 const local=await f.add();await f.call('models.default',{profileId:local.id});
 await assert.rejects(f.call('models.project',{projectId:p.id,profileId:local.id}),/Review or stop/);
 const e=(await f.call('workflow.status',{id:w.id})).events.find((e:any)=>e.kind==='manager_request');f.faux.appendResponses([fauxAssistantMessage('Done')]);
 const next=(await f.call('workflow.answer',{id:w.id,eventId:e.eventId,answer:'Yes'})).assignment;
 await f.call('assignments.wait',{id:next.id,timeoutMs:10000});assert.equal((await f.call('assignments.show',{id:next.id})).state,'needs_review');
 assert.equal((await f.call('models.settings',{projectId:p.id})).projectProfileId,'existing');
}finally{await f.close();}});

async function wireFixture(coding=false){const requests:any[]=[];const server=createServer(async(req,res)=>{if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'local-code'}]}));return;}let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);const result=body.messages.find((m:any)=>m.role==='tool');const nonce=body.messages.find((m:any)=>m.role==='user').content.match(/[a-f0-9]{8}-[a-f0-9-]{27}/)?.[0];res.writeHead(200,{'Content-Type':'text/event-stream'});const delta=coding?(result?{role:'assistant',content:'Created proof.txt.'}:{role:'assistant',tool_calls:[{index:0,id:'write_1',type:'function',function:{name:'write',arguments:JSON.stringify({path:'proof.txt',content:'LOCAL_PROFILE_OK\n'})}}]}):result?{role:'assistant',content:result.content}:{role:'assistant',tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'readiness_echo',arguments:JSON.stringify({value:nonce})}}]};res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'local-code',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'local-code',choices:[{index:0,delta:{},finish_reason:result?'stop':'tool_calls'}]})}\n\n`);res.end('data: [DONE]\n\n');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return {requests,url:`http://127.0.0.1:${(server.address() as any).port}/v1`,close:()=>new Promise<void>(r=>server.close(()=>r()))};}
test('generic OpenAI-compatible streaming tool round trip and discovery use actual transport without DeepSeek assumptions',async()=>{const f=await fixture(),wire=await wireFixture();try{const p=await f.add(wire.url);assert.deepEqual((await f.call('models.discover',{connectionId:p.connectionId})).models,['local-code']);const result=await f.call('models.test',{profileId:p.id});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(wire.requests.length,2);assert.equal(wire.requests[0].stream,true);assert.equal(wire.requests[0].max_tokens,2048);assert.equal(wire.requests[0].reasoning_effort,undefined);assert.equal(wire.requests[1].messages.find((m:any)=>m.role==='assistant').reasoning_content,undefined);}finally{await wire.close();await f.close();}});
test('browser settings are narrow, same-origin and CSRF protected; ordinary viewer stays read-only',async()=>{const f=await fixture();const viewer=await startTerminalBrowser({stateDir:f.dir,rpc:{call:f.call}});try{
 const s=await (await fetch(viewer.url+'/settings')).json() as any;assert.ok(s.csrf);const body=JSON.stringify({action:'connection.add',params:{name:'Browser',endpoint:'http://localhost:9000/v1',noAuth:true,requestId:'browser'}});
 assert.equal((await fetch(viewer.url+'/settings',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);
 assert.equal((await fetch(viewer.url+'/settings',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.invalid','X-Pi-Settings':s.csrf},body})).status,403);
 assert.equal((await fetch(viewer.url+'/settings',{method:'POST',headers:{'Content-Type':'application/json',Origin:viewer.url,'X-Pi-Settings':s.csrf},body})).status,200);
 assert.equal((await fetch(viewer.url+'/settings',{method:'POST',headers:{'Content-Type':'application/json',Origin:viewer.url,'X-Pi-Settings':s.csrf},body:JSON.stringify({action:'assignments.submit',params:{}})})).status,400);
 assert.equal((await fetch(viewer.url+'/events',{method:'POST'})).status,405);
}finally{await viewer.close();await f.close();}});
test('real Chrome Settings tab adds a connection/profile and selects default and project without starting a worker',async()=>{
 const f=await fixture();const p=await f.project('browser'),w=(await f.call('workflow.open',{projectId:p.id,threadId:randomUUID(),objective:'Settings acceptance',roadmap:'No worker'})).workflow;
 const viewer=await startTerminalBrowser({stateDir:f.dir,rpc:{call:f.call}});const {chromium}=await import('playwright-core');let browser:any;
 try{browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const page=await browser.newPage({viewport:{width:700,height:850}});page.setDefaultTimeout(10000);const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.goto(viewer.url+'/?workflowId='+w.id+'#settings');
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
