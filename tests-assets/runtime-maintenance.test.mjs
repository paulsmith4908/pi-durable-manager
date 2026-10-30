import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runtimeLock } from '../scripts/runtime-lock.mjs';
import { maintainRuntime, inspectInstallation } from '../plugin/skills/pi-durable-manager/scripts/maintenance.mjs';
import { acquireInstallLock, installRuntime, run, setupDiagnostic } from '../plugin/skills/pi-durable-manager/scripts/runtime-install.mjs';

async function fixture() {
 const home=await mkdtemp(join(tmpdir(),'pi-maintenance-'));await mkdir(join(home,'state'),{mode:0o700});
 const config='{"synthetic":"preserve opaque config bytes"}\n';await writeFile(join(home,'config.json'),config,{mode:0o600});
 const db=new DatabaseSync(join(home,'state/metadata.sqlite'));
 db.exec("CREATE TABLE schema_meta(key TEXT,value TEXT); INSERT INTO schema_meta VALUES('schema_version','8'); CREATE TABLE assignments(id TEXT,state TEXT,lease_path TEXT); CREATE TABLE process_receipts(state TEXT);");db.close();
 async function runtime(version,schema=8){const dir=join(home,'runtimes',version,'node_modules/pi-durable-manager');await mkdir(join(dir,'bin'),{recursive:true});await mkdir(join(dir,'dist'));await writeFile(join(dir,'package.json'),'{"type":"module"}');await writeFile(join(dir,'dist/store.js'),'export const SCHEMA_VERSION='+schema+';');const bin=join(dir,'bin/pi-durable.js');await writeFile(bin,'console.log(JSON.stringify({ok:true,result:{version:'+JSON.stringify(version)+'}}));');return {bin,version,sha256:'fake-fixture',lockSha256:'fake-lock'};}
 const old=await runtime('old'),next=await runtime('next');const pointer={schemaVersion:1,version:old.version,bin:old.bin,node:process.execPath,configPath:join(home,'config.json'),dataHome:home};await writeFile(join(home,'installation.json'),JSON.stringify(pointer),{mode:0o600});
 return {home,config,old,next,runtime,installer:async()=>next,sql(query){const d=new DatabaseSync(join(home,'state/metadata.sqlite'));try{d.exec(query)}finally{d.close()}},close:()=>rm(home,{recursive:true,force:true})};
}
test('runtime lock keeps exact production versions, removes development packages and pins payload integrity',()=>{
 const pkg={version:'1.0.0',dependencies:{dep:'^1'},bin:{pi:'./bin/pi.js'}},source={lockfileVersion:3,packages:{'':{version:'1.0.0',dependencies:pkg.dependencies},'node_modules/dep':{version:'1.2.3',resolved:'https://registry.npmjs.org/dep/-/dep-1.2.3.tgz',integrity:'sha512-fixture'},'node_modules/dev':{version:'9',dev:true}}};
 const a=runtimeLock(source,pkg,'pi-durable-manager-1.0.0.tgz',Buffer.from('fixture'));
 assert.equal(a.lock.packages['node_modules/dep'].version,'1.2.3');assert.ok(!a.lock.packages['node_modules/dev']);assert.match(a.lock.packages['node_modules/pi-durable-manager'].integrity,/^sha512-/);assert.equal(a.pkg.dependencies['pi-durable-manager'],'file:pi-durable-manager-1.0.0.tgz');assert.deepEqual(runtimeLock(source,pkg,'pi-durable-manager-1.0.0.tgz',Buffer.from('fixture')),a);
 assert.throws(()=>runtimeLock({...source,lockfileVersion:2},pkg,'payload',Buffer.from('')),/missing or stale/);
});
test('upgrade and rollback preserve configuration/current state and retain private backup',async()=>{
 const f=await fixture();try{
  const result=await maintainRuntime({action:'upgrade',dataHome:f.home,installer:f.installer});assert.equal(result.version,'next');assert.equal(result.restartRequired,true);assert.equal(await readFile(join(f.home,'config.json'),'utf8'),f.config);assert.equal(await readFile(join(result.backup,'config.json'),'utf8'),f.config);
  f.sql("INSERT INTO assignments VALUES('new-work','accepted',NULL)");
  const back=await maintainRuntime({action:'rollback',dataHome:f.home});assert.equal(back.version,'old');assert.equal((await inspectInstallation(f.home)).version,'old');const db=new DatabaseSync(join(f.home,'state/metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) AS n FROM assignments').get().n,1);db.close();
  await assert.rejects(access(join(f.home,'state/service.lock')),{code:'ENOENT'});
 }finally{await f.close()}
});
test('maintenance never installs while service owns state, a checkout lease exists, or a command is unresolved',async()=>{
 const f=await fixture();let installs=0;const installer=async()=>{installs++;return f.next;};try{
  await writeFile(join(f.home,'state/service.lock'),JSON.stringify({pid:process.pid,token:'fixture'}));await assert.rejects(maintainRuntime({action:'upgrade',dataHome:f.home,installer}),/Stop the idle service/);await rm(join(f.home,'state/service.lock'));
  f.sql("INSERT INTO assignments VALUES('active','needs_review','/fixture')");await assert.rejects(maintainRuntime({action:'upgrade',dataHome:f.home,installer}),/active leases/);f.sql('DELETE FROM assignments');
  f.sql("INSERT INTO process_receipts VALUES('in_doubt')");await assert.rejects(maintainRuntime({action:'upgrade',dataHome:f.home,installer}),/in-doubt/);assert.equal(installs,0);assert.equal((await inspectInstallation(f.home)).version,'old');
 }finally{await f.close()}
});
test('schema-changing candidates are refused without switching pointer or overwriting state',async()=>{
 const f=await fixture();try{const incompatible=await f.runtime('future',9);await assert.rejects(maintainRuntime({action:'upgrade',dataHome:f.home,installer:async()=>incompatible}),/reviewed migration/);assert.equal((await inspectInstallation(f.home)).version,'old');assert.equal(await readFile(join(f.home,'config.json'),'utf8'),f.config);}finally{await f.close()}
});
test('repair recovers a missing runtime pointer and incomplete durable operation without changing config',async()=>{
 const f=await fixture();try{
  await rm(join(f.home,'installation.json'));
  const result=await maintainRuntime({action:'repair',dataHome:f.home,installer:f.installer});assert.equal(result.version,'next');assert.equal(await readFile(join(f.home,'config.json'),'utf8'),f.config);
  const history=JSON.parse(await readFile(join(f.home,'runtime-history.json'),'utf8'));await writeFile(join(f.home,'maintenance-pending.json'),JSON.stringify(history[0]));
  await assert.rejects(maintainRuntime({action:'upgrade',dataHome:f.home,installer:f.installer}),/incomplete/);
  await maintainRuntime({action:'repair',dataHome:f.home,installer:f.installer});await assert.rejects(access(join(f.home,'maintenance-pending.json')),{code:'ENOENT'});
 }finally{await f.close()}
});
test('repair refuses to reclaim a live installer lock',async()=>{
 const home=await mkdtemp(join(tmpdir(),'pi-install-lock-'));try{const path=join(home,'lock'),release=await acquireInstallLock(path);await assert.rejects(acquireInstallLock(path,true),/still live/);await release();}finally{await rm(home,{recursive:true,force:true})}
});

test('repair can reclaim a provably exited owner but normal install does not silently reclaim',async()=>{
 const home=await mkdtemp(join(tmpdir(),'pi-dead-lock-'));try{const path=join(home,'lock'),pid=Number(execFileSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'}));await writeFile(path,JSON.stringify({pid,token:'fixture'}));await assert.rejects(acquireInstallLock(path),/Another installer/);const release=await acquireInstallLock(path,true);await release();await assert.rejects(access(path),{code:'ENOENT'});}finally{await rm(home,{recursive:true,force:true})}
});
test('dependency lock tampering is rejected before package installation',async()=>{
 const home=await mkdtemp(join(tmpdir(),'pi-lock-tamper-'));try{const pluginRoot=join(home,'plugin'),service=join(pluginRoot,'service');await mkdir(service,{recursive:true});const bytes=Buffer.from('synthetic payload'),hash=createHash('sha256').update(bytes).digest('hex');await writeFile(join(service,'pi-durable-manager-fixture.tgz'),bytes);await writeFile(join(service,'runtime-package.json'),'{}');await writeFile(join(service,'runtime-lock.json'),'{}');await writeFile(join(service,'runtime.json'),JSON.stringify({schemaVersion:2,version:'fixture',file:'pi-durable-manager-fixture.tgz',sha256:hash,packageFile:'runtime-package.json',lockFile:'runtime-lock.json',packageSha256:'0'.repeat(64),lockSha256:'0'.repeat(64)}));await assert.rejects(installRuntime({dataHome:join(home,'data'),pluginRoot}),/graph checksum mismatch/);}finally{await rm(home,{recursive:true,force:true})}
});

test('command diagnostics preserve only safe phase, code and exit status', async () => {
 await assert.rejects(run('/definitely-missing-command', [], {phase:'dependencies'}), error => {
  assert.deepEqual(setupDiagnostic(error), {code:'COMMAND_MISSING',phase:'dependencies',message:'A required setup command is missing. Check Node and npm installation.'}); return true;
 });
 await assert.rejects(run(process.execPath,['-e','process.stderr.write("synthetic-secret-token");process.exit(7)'],{phase:'service_start'}),error=>{
  const diagnostic=setupDiagnostic(error);assert.equal(diagnostic.code,'COMMAND_FAILED');assert.equal(diagnostic.phase,'service_start');assert.equal(diagnostic.exitCode,7);assert.ok(!JSON.stringify(diagnostic).includes('synthetic-secret'));return true;
 });
 assert.ok(!JSON.stringify(setupDiagnostic(Object.assign(new Error('synthetic-secret-token'),{code:'COMMAND_FAILED',phase:'service_start'}))).includes('synthetic-secret'));
});
test('installer lock release never removes a replacement claim from the same process',async()=>{
 const home=await mkdtemp(join(tmpdir(),'pi-lock-ownership-'));try{const path=join(home,'lock'),release=await acquireInstallLock(path);await writeFile(path,JSON.stringify({pid:process.pid,token:'replacement'}));await release();assert.equal(JSON.parse(await readFile(path,'utf8')).token,'replacement');}finally{await rm(home,{recursive:true,force:true})}
});
