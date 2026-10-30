#!/usr/bin/env node
// Real previous-release installation, upgrade, rollback and repair. Synthetic
// configuration only; no inference, production state or credential inspection.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const previous=process.argv[2];
assert.ok(previous,'Supply the previous prepared plugin directory.');
const pluginRoot=join(root,'artifacts/repository/plugins/pi-durable-manager');
const script=(plugin,name)=>pathToFileURL(join(resolve(plugin),'skills/pi-durable-manager/scripts',name)).href;
const {configureService}=await import(script(previous,'onboard.mjs'));
const {maintainRuntime}=await import(script(pluginRoot,'maintenance.mjs'));
const {run}=await import(script(pluginRoot,'runtime-install.mjs'));
const dataHome=await mkdtemp(join(tmpdir(),'pi-upgrade-'));
const report={at:new Date().toISOString(),ok:false,checks:{},scope:'Real archived runtimes on this Mac with synthetic offline config; no inference or native GUI wake claim.'};
let current,stopped=true;
const cli=async(action)=>JSON.parse(await run(process.execPath,[current.bin,'service',action,'--config',current.configPath,'--json']));
const pointer=async()=>JSON.parse(await readFile(join(dataHome,'installation.json'),'utf8'));
const configHash=async()=>createHash('sha256').update(await readFile(join(dataHome,'config.json'))).digest('hex');
async function stop(){assert.equal((await cli('stop')).result.ok,true);stopped=true;}
async function startAndCheck(version){stopped=false;assert.equal((await cli('start')).result.ok,true);assert.equal((await cli('status')).result.status.packageVersion,version);}
try {
 current=await configureService({endpoint:'http://127.0.0.1:1/v1',model:'upgrade-no-inference',contextWindow:32768,maxTokens:4096,noAuth:true,allowNetwork:false},{dataHome,pluginRoot:resolve(previous),progress(){}});
 stopped=false;report.from=current.version;const before=await configHash();await stop();report.checks.previousReleaseInstalled=true;
 const upgraded=await maintainRuntime({action:'upgrade',dataHome,pluginRoot});current=await pointer();report.to=current.version;
 await startAndCheck(upgraded.version);assert.equal(await configHash(),before);report.checks.upgradePreservesConfig=true;
 const {PiClient}=await import(pathToFileURL(join(dirname(current.bin),'../dist/client.js')).href);
 const client=await PiClient.connect({stateDir:join(dataHome,'state')});let project;
 try {
  const settings=await client.call('models.settings',{});assert.equal(settings.profiles[0].model,'upgrade-no-inference');
  const policy=await client.call('permissions.read',{});assert.equal(policy.policy.network,false);
  project=(await client.call('projects.create',{name:'after-upgrade',path:join(dataHome,'projects/after-upgrade'),requestId:'upgrade-project'},'upgrade-project')).project;
  await assert.rejects(access(join(project.path,'AGENTS.md')),{code:'ENOENT'});
  await writeFile(join(project.path,'proof.txt'),'preserve current work\n');
 }finally{client.close();}
 await stop();await maintainRuntime({action:'rollback',dataHome,pluginRoot});current=await pointer();assert.equal(current.version,report.from);
 await startAndCheck(report.from);assert.equal(await configHash(),before);assert.equal(await readFile(join(project.path,'proof.txt'),'utf8'),'preserve current work\n');await stop();report.checks.rollbackPreservesNewWork=true;
 await maintainRuntime({action:'upgrade',dataHome,pluginRoot});current=await pointer();
 // Missing executable, private disposable runtime only. Repair must reinstall the
 // locked candidate and retain the existing configuration and metadata.
 await rm(current.bin);await maintainRuntime({action:'repair',dataHome,pluginRoot});current=await pointer();await startAndCheck(report.to);
 assert.equal(await configHash(),before);assert.equal(await readFile(join(project.path,'proof.txt'),'utf8'),'preserve current work\n');await stop();report.checks.missingRuntimeRepair=true;
 report.ok=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
 if(!stopped&&current){try{await stop();}catch{report.cleanup='Disposable service needs review.';report.ok=false;process.exitCode=1;}}
 if(stopped)await rm(dataHome,{recursive:true,force:true});else report.retainedTemporaryDirectory=dataHome;
 await mkdir(join(root,'artifacts'),{recursive:true});await writeFile(join(root,'artifacts/upgrade-verification.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}
