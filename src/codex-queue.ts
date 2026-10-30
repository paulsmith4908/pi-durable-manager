/** Narrow control-only client for the installed Codex app-server queue API.
 * No thread resume/start, turn, model request, daemon start or credential access.
 * A temporary stdio process accesses the same durable queue as `codex queue`.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export async function deleteCodexQueuedMessage(
  executable: string, env: Record<string,string>, threadId: string, receipt: string,
  timeoutMs: number, signal?: AbortSignal,
): Promise<{deleted:boolean}> {
  const child=spawn(executable,['app-server','--stdio'],{env,stdio:['pipe','pipe','pipe']});
  let sequence=0, ended=false;
  const pending=new Map<number,{resolve:(v:any)=>void,reject:(e:Error)=>void}>();
  const fail=(error:Error)=>{ended=true;for(const p of pending.values())p.reject(error);pending.clear();};
  // Discard server diagnostics (may contain unrelated host context); report
  // only bounded protocol errors to the caller's redaction layer.
  child.stderr.resume();
  child.stdin.on('error',e=>fail(e));
  child.on('error',e=>fail(e));
  const joined=new Promise<void>(resolve=>child.once('close',()=>{fail(Error('Codex queue control process closed'));resolve();}));
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    if(line.length>2_000_000){fail(Error('Oversized Codex queue response'));child.kill();return;}
    let m:any;try{m=JSON.parse(line);}catch{return;}
    const p=pending.get(m.id);if(!p)return;pending.delete(m.id);
    if(m.error)p.reject(Error(`Codex queue API: ${String(m.error.message??'request failed').slice(0,500)}`));else p.resolve(m.result);
  });
  const abort=()=>{fail(Error('Codex queue cleanup interrupted'));child.kill('SIGTERM');};
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,timeoutMs);
  const call=(method:string,params:unknown):Promise<any>=>new Promise((resolve,reject)=>{
    if(ended||signal?.aborted){reject(Error('Codex queue control unavailable'));return;}
    const id=++sequence;pending.set(id,{resolve,reject});
    child.stdin.write(JSON.stringify({id,method,params})+'\n',e=>{if(e)fail(e);});
  });
  try {
    await call('initialize',{clientInfo:{name:'pi_durable_queue_cleanup',title:null,version:'1'},capabilities:{experimentalApi:true,requestAttestation:false}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const result=await call('thread/queue/delete',{threadId,queuedSubmissionId:receipt});
    if(typeof result?.deleted!=='boolean')throw Error('Unsupported Codex queue-delete response');
    return {deleted:result.deleted};
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',abort);lines.close();child.stdin.end();child.kill('SIGTERM');
    const kill=setTimeout(()=>child.kill('SIGKILL'),1000);
    await joined;clearTimeout(kill);
  }
}
