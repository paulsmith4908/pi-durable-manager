import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {MetadataStore,type AssignmentRecord} from '../src/store.js';
import {parseProfile,snapshotSite,runHostValidation,profileKey} from '../src/host-validation.js';
import {briefNotes,briefFiles,briefView} from '../src/working-brief.js';
const profile={name:'counter',serveDirectory:'dist',steps:[{action:'click' as const,selector:'#add'},{action:'text' as const,selector:'#count',value:'1'}]};
test('host profiles reject arbitrary execution, remote navigation and escaping roots',()=>{
 for(const change of [{serveDirectory:'../secret'},{serveDirectory:'/tmp'},{steps:[{action:'evaluate',value:'process.exit()'}]},{steps:[{action:'goto',value:'https://example.org'}]},{steps:[{action:'goto',value:'//localhost'}]}])assert.throws(()=>parseProfile({...profile,...change}));
 assert.deepEqual(parseProfile(profile),profile);
});
test('static snapshots omit hidden files, reject links, and do not change with later edits',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pdm-validation-'));try{await mkdir(join(root,'dist'));await writeFile(join(root,'dist/index.html'),'one');await writeFile(join(root,'dist/.env'),'never serve');const files=await snapshotSite(root,'dist');assert.equal(files.size,1);await writeFile(join(root,'dist/index.html'),'two');assert.equal(files.get('/index.html')!.toString(),'one');await symlink('/etc/passwd',join(root,'dist/escape.txt'));await assert.rejects(snapshotSite(root,'dist'),/symlink/);}finally{await rm(root,{recursive:true,force:true})}
});
test('brief persists with verified hashes, detects changed/unavailable paths and only inherits explicit same-project lineage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pdm-brief-'));let store=await MetadataStore.open(join(root,'state.sqlite'));try{
 await writeFile(join(root,'main.js'),'one');const notes=briefNotes({objective:'Implement counter',decisions:['Use integers'],completed:[],issues:['Counter fails'],nextStep:'Fix increment'});const files=await briefFiles(root,['main.js']);const parent={id:'parent',projectId:'project',parentId:null} as AssignmentRecord;const child={id:'child',projectId:'project',parentId:'parent'} as AssignmentRecord;
 store.setControl('working-brief:parent',{assignmentId:'parent',updatedAt:1,notes,files});store.close();store=await MetadataStore.open(join(root,'state.sqlite'));
 const mock={getControl:store.getControl.bind(store),getAssignment:(id:string)=>id==='parent'?parent:undefined} as MetadataStore;
 let view:any=await briefView(mock,child,root);assert.equal(view.inherited,true);assert.equal(view.files[0].freshness,'unchanged');await writeFile(join(root,'main.js'),'two');view=await briefView(mock,child,root);assert.equal(view.files[0].freshness,'changed');assert.equal(await briefView(mock,{...child,projectId:'other'},root),null);assert.equal(await briefView(mock,{...child,parentId:null},root),null);await rm(join(root,'main.js'));view=await briefView(mock,child,root);assert.equal(view.files[0].freshness,'unavailable');await assert.rejects(briefFiles(root,['../outside']));assert.throws(()=>briefNotes({...notes,nextStep:'x'.repeat(1201)}));
 }finally{store.close();await rm(root,{recursive:true,force:true})}
});
test('host Chrome reports real failure then pass, preserves exact replay result and never replays in-doubt work',{skip:process.env.PDM_HOST_BROWSER_TEST!=='1'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'pdm-host-browser-'));const store=await MetadataStore.open(join(root,'state.sqlite'));try{
 await mkdir(join(root,'dist'));const file=join(root,'dist/index.html');await writeFile(file,'<button id="add">Add</button><p id="count">0</p>');store.setControl(profileKey('project','counter'),profile);const row={id:'assignment',projectId:'project'} as AssignmentRecord;
 const opts={store,row,root,stateDir:join(root,'state'),profileName:'counter',callId:'failure',protectedPaths:[],admitted:()=>true};const failed=await runHostValidation(opts);assert.equal(failed.state,'failed');assert.match(failed.error!,/expected.*1.*got.*0/);assert.ok(failed.artifacts?.[0]);await readFile(failed.artifacts![0]!.path);
 await writeFile(file,'<button id="add" onclick="document.querySelector(\'#count\').textContent=1">Add</button><p id="count">0</p>');const replay=await runHostValidation(opts);assert.deepEqual(replay,failed);const passed=await runHostValidation({...opts,callId:'pass'});assert.equal(passed.state,'passed');assert.notEqual(passed.sourceHash,failed.sourceHash);
 store.setControl('validation-run:assignment:uncertain',{...passed,state:'running'});const doubt=await runHostValidation({...opts,callId:'uncertain'});assert.equal(doubt.state,'in_doubt');await assert.rejects(runHostValidation({...opts,callId:'denied',admitted:()=>false}),/admitted/);
 store.setControl(profileKey('project','external'),{...profile,name:'external',steps:[{action:'click',selector:'#add'}]});await writeFile(file,'<button id="add" onclick="fetch(\'http://127.0.0.1:9/forbidden\').catch(()=>{})">Add</button>');
 const external=await runHostValidation({...opts,callId:'external',profileName:'external'});assert.equal(external.state,'failed');assert.ok(external.consoleErrors?.length || external.blockedRequests);
 }finally{store.close();await rm(root,{recursive:true,force:true})}
});
