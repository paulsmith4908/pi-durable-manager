/** Trusted, declarative browser validation. Never executes project Node/shell code on the host. */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { chromium } from 'playwright-core';
import { resolvePolicy, resolveWithinRoot, readFileNoFollow } from './sandbox.js';
import type { MetadataStore, AssignmentRecord } from './store.js';

export type BrowserStep = { action: 'goto'|'click'|'fill'|'press'|'text'|'count'|'reload'; selector?: string; value?: string; count?: number };
export interface ValidationProfile { name: string; serveDirectory: string; steps: BrowserStep[]; }
export interface ValidationResult { id: string; assignmentId: string; profile: string; profileHash: string; state: 'running'|'passed'|'failed'|'in_doubt'; at: number; finishedAt?: number; sourceHash?: string; completedSteps: number; error?: string; consoleErrors?: string[]; blockedRequests?: number; artifacts?: { path: string; sha256: string }[]; }
export const profileKey=(projectId:string,name:string)=>`validation-profile:${projectId}:${name}`;
export function parseProfile(raw: unknown): ValidationProfile {
  const p=raw as ValidationProfile;
  if(!p || !/^[a-z][a-z0-9-]{0,49}$/.test(p.name) || typeof p.serveDirectory!=='string' || p.serveDirectory.length>250)throw Error('Invalid validation profile');
  if(p.serveDirectory.startsWith('/') || p.serveDirectory.split('/').some(x=>x==='..'||x.startsWith('.')&&x!=='.'))throw Error('serveDirectory must be a public project-relative directory');
  if(!Array.isArray(p.steps)||!p.steps.length||p.steps.length>24)throw Error('Profile needs 1–24 browser steps');
  const steps=p.steps.map(s=>{
    if(!s || !['goto','click','fill','press','text','count','reload'].includes(s.action))throw Error('Unsupported browser action');
    if(s.selector!==undefined && (typeof s.selector!=='string'||s.selector.length>300))throw Error('Invalid selector');
    if(s.value!==undefined && (typeof s.value!=='string'||s.value.length>1000))throw Error('Invalid value');
    if(['click','fill','press','text','count'].includes(s.action)&&!s.selector)throw Error('Selector required');
    if(['goto','fill','press','text'].includes(s.action)&&typeof s.value!=='string')throw Error('Value required');
    if(s.action==='goto'&&(!s.value!.startsWith('/')||s.value!.startsWith('//')||s.value!.includes('\\')))throw Error('Navigation must be a local path');
    if(s.action==='count'&&(!Number.isInteger(s.count)||s.count!<0||s.count!>1000))throw Error('Invalid count');
    return {action:s.action,...(s.selector!==undefined?{selector:s.selector}:{}),...(s.value!==undefined?{value:s.value}:{}),...(s.count!==undefined?{count:s.count}:{})};
  });return {name:p.name,serveDirectory:p.serveDirectory,steps};
}
const hash=(x:Buffer|string)=>createHash('sha256').update(x).digest('hex');
const types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2','.ico':'image/x-icon','.txt':'text/plain'};
/** Snapshot public assets before launch; no symlinks, hidden files, or live filesystem serving. */
export async function snapshotSite(root:string,directory:string,protectedPaths:readonly string[]=[]):Promise<Map<string,Buffer>> {
  const policy=resolvePolicy({root,protectedPaths}),files=new Map<string,Buffer>();let total=0;
  const walk=async(rel:string,url:string,depth:number):Promise<void>=>{
    if(depth>12)throw Error('Static site too deep');
    const abs=await resolveWithinRoot(policy,rel,'read');
    for(const name of (await readdir(abs)).sort()){
      if(name.startsWith('.')||name==='node_modules')continue;
      const path=join(abs,name),info=await lstat(path);if(info.isSymbolicLink())throw Error('Static site symlinks are forbidden');
      if(info.isDirectory()){await walk(join(rel,name),url+name+'/',depth+1);continue;}
      if(!info.isFile()||!types[extname(name).toLowerCase()])continue;
      if(files.size>=512)throw Error('Static site exceeds 512 files');
      const bytes=await readFileNoFollow(await resolveWithinRoot(policy,join(rel,name),'read'),8*1024*1024);total+=bytes.length;if(total>32*1024*1024)throw Error('Static site exceeds 32 MiB');files.set(url+name,bytes);
    }
  };await walk(directory,'/',0);if(!files.has('/index.html'))throw Error('Build missing: serveDirectory must contain index.html');return files;
}
export function recentValidation(store:MetadataStore,assignmentId:string):ValidationResult[] {return store.getControl<ValidationResult[]>(`validation-results:${assignmentId}`)??[];}
export async function runHostValidation(opts:{store:MetadataStore; row:AssignmentRecord; root:string; stateDir:string; profileName:string; callId:string; protectedPaths:readonly string[]; admitted:()=>boolean}):Promise<ValidationResult> {
  const {store,row}=opts,key=`validation-run:${row.id}:${opts.callId}`;
  const prior=store.getControl<ValidationResult>(key);
  if(prior)return prior.state==='running'?{...prior,state:'in_doubt',error:'Prior validation did not record completion. Never auto-replay; inspect and request a new validation explicitly.'}:prior;
  if(!opts.admitted())throw Error('Assignment is no longer admitted');
  const configured=store.getControl<ValidationProfile>(profileKey(row.projectId,opts.profileName));if(!configured)throw Error('No manager-configured host validation profile by that name');
  const profile=parseProfile(configured),result:ValidationResult={id:randomUUID(),assignmentId:row.id,profile:profile.name,profileHash:hash(JSON.stringify(profile)),state:'running',at:Date.now(),completedSteps:0};
  const save=()=>{store.setControl(key,result);store.setControl(`validation-results:${row.id}`,[...recentValidation(store,row.id).filter(r=>r.id!==result.id).slice(-5),result]);};
  save();store.appendActivity({kind:'validation.started',projectId:row.projectId,assignmentId:row.id,requestId:null,dedupKey:`validation:${result.id}:started`,data:result});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,server:ReturnType<typeof createServer>|undefined;
  const artifacts=join(opts.stateDir,'validation-artifacts',result.id);await mkdir(artifacts,{recursive:true,mode:0o700});
  try{
    const files=await snapshotSite(opts.root,profile.serveDirectory,opts.protectedPaths);
    const manifest=[...files].map(([path,bytes])=>({path,sha256:hash(bytes)}));result.sourceHash=hash(JSON.stringify(manifest));
    await writeFile(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
    let origin='';server=createServer((req,res)=>{
      if(req.headers.host!==new URL(origin).host||!['GET','HEAD'].includes(req.method??'')){res.writeHead(403).end();return;}
      const u=new URL(req.url??'/',origin);let path;try{path=decodeURIComponent(u.pathname);}catch{res.writeHead(400).end();return;}
      if(path==='/favicon.ico'&&!files.has(path)){res.writeHead(204).end();return;}
      const bytes=files.get(path==='/'?'/index.html':path);if(!bytes){res.writeHead(404).end();return;}
      res.writeHead(200,{'Content-Type':types[extname(path==='/'?'/index.html':path)]??'application/octet-stream','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);
    });await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',resolve)});origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:artifacts,TMPDIR:artifacts}});
    const context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block',viewport:{width:1280,height:900}});result.blockedRequests=0;result.consoleErrors=[];
    await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===origin&&['GET','HEAD'].includes(route.request().method()))await route.continue();else{result.blockedRequests!++;await route.abort();}});
    await context.routeWebSocket('**/*',socket=>socket.close());
    const page=await context.newPage();context.on('page',p=>{if(p!==page)void p.close()});page.on('dialog',d=>void d.dismiss());page.on('pageerror',e=>{if(result.consoleErrors!.length<8)result.consoleErrors!.push(e.message.slice(0,800))});page.on('console',m=>{if(m.type()==='error'&&result.consoleErrors!.length<8)result.consoleErrors!.push(m.text().slice(0,800))});page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(15000);
    try{
      await page.goto(origin);
      for(const step of profile.steps){
        if(!opts.admitted())throw Error('Assignment admission closed during validation');
        const locator=step.selector?page.locator(step.selector):undefined;
        switch(step.action){
          case 'goto':{const url=new URL(step.value!,origin);if(url.origin!==origin)throw Error('Navigation escaped site');await page.goto(url.href);break;}
          case 'reload':await page.reload();break;
          case 'click':await locator!.click();break;
          case 'fill':await locator!.fill(step.value!);break;
          case 'press':await locator!.press(step.value!);break;
          case 'text':{await locator!.waitFor();const actual=await locator!.innerText();if(actual!==step.value)throw Error(`Step ${result.completedSteps+1}: ${step.selector} expected ${JSON.stringify(step.value)}, got ${JSON.stringify(actual.slice(0,1000))}`);break;}
          case 'count':{const actual=await locator!.count();if(actual!==step.count)throw Error(`Step ${result.completedSteps+1}: ${step.selector} expected count ${step.count}, got ${actual}`);break;}
        }result.completedSteps++;
      }
      if(result.consoleErrors.length)throw Error('Browser page errors: '+result.consoleErrors.join('; '));
      if(result.blockedRequests)throw Error('Page attempted requests outside the isolated static site');
      result.state='passed';
    }catch(e){result.state='failed';result.error=String(e).slice(0,2200);}
    const image=await page.screenshot({timeout:10000});await writeFile(join(artifacts,'page.png'),image,{mode:0o600});result.artifacts=[{path:join(artifacts,'page.png'),sha256:hash(image)}];
  }catch(e){result.state='failed';result.error=String(e).slice(0,2200);}
  finally{await browser?.close().catch(()=>{});if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}}
  result.finishedAt=Date.now();save();await writeFile(join(artifacts,'result.json'),JSON.stringify(result,null,2),{mode:0o600});store.appendActivity({kind:'validation.completed',projectId:row.projectId,assignmentId:row.id,requestId:null,dedupKey:`validation:${result.id}:completed`,data:result});return result;
}
