/** Bounded read-only transcript pages. History never starts/resumes a worker. */
import { readAssignmentSummary, type ObserverRpc } from './native-terminal.js';
type Row = Record<string, any>;
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function link(assignmentId:string, params:Record<string,string|number>={}):string {
  return '/history?'+new URLSearchParams({assignmentId,...Object.fromEntries(Object.entries(params).map(([k,v])=>[k,String(v)]))}).toString();
}
export async function recordedHistory(rpc:ObserverRpc,url:URL):Promise<string> {
  const assignmentId=url.searchParams.get('assignmentId');
  if(!assignmentId||!/^pdm-a-[a-f0-9-]{36}$/.test(assignmentId))throw new RangeError('Choose an existing assignment');
  const assignment=await readAssignmentSummary(rpc,assignmentId);
  let content:string;
  const requestedEntry=url.searchParams.get('entryId');
  if(requestedEntry!==null){
    const entryId=Number(requestedEntry),offset=Number(url.searchParams.get('offset')??0);
    if(!Number.isSafeInteger(entryId)||entryId<1||!Number.isSafeInteger(offset)||offset<0)throw new RangeError('Invalid entry or chunk cursor');
    const page=await rpc.call<Row>('sessions.entry',{id:assignment.sessionId,entryId,offset,maxChars:16384});
    content=`<p>Entry ${escape(entryId)} · characters ${escape(page.offset)}–${escape(page.offset+page.chunk.length)} of ${escape(page.totalChars)}. Chunks may split a JSON value.</p><pre>${escape(page.chunk)}</pre>`+
      (page.nextOffset!==null?`<a rel="next" href="${escape(link(assignmentId,{entryId,offset:page.nextOffset}))}">Next chunk →</a>`:'<p>End of entry.</p>');
  }else{
    const cursor=url.searchParams.get('cursor');
    if(cursor!==null&&cursor.length>8192)throw new RangeError('Invalid history cursor');
    const page=await rpc.call<Row>('sessions.transcript',{id:assignment.sessionId,order:'ascending',limit:20,...(cursor?{cursor}:{})});
    content=page.entries.map((entry:Row)=>`<article><h2>Entry ${escape(entry.id)} · ${escape(entry.kind)}</h2>`+
      (entry.truncated?`<p>This entry exceeds the page limit. <a href="${escape(link(assignmentId,{entryId:entry.entryId??entry.id}))}">Read the full entry in chunks →</a></p>`:`<pre>${escape(JSON.stringify(entry,null,2))}</pre>`)+`</article>`).join('')||'<p>No recorded output yet.</p>';
    content+=page.nextCursor?`<a rel="next" href="${escape(link(assignmentId,{cursor:page.nextCursor}))}">Next page →</a>`:'<p>End of recorded history. Reload to check for newly recorded entries.</p>';
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi recorded output</title><style>body{margin:24px;background:#131519;color:#dce0e5;font:13px ui-monospace,monospace;line-height:1.5}h1{font-size:20px}h2{font-size:14px}a{color:#b4d4ff}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#1c2026}article{border-bottom:1px solid #343a43;padding:12px 0}nav{position:sticky;top:0;background:#131519;padding:10px 0}</style><h1>Recorded output</h1><p>Saved conversation entries, oldest first. Read-only; no model calls. Each page and entry chunk is bounded. The live terminal is unchanged.</p><p>Assignment ${escape(assignmentId)}</p><nav><a href="${escape(link(assignmentId))}">First page</a> · Use your browser’s Back button for the previous page.</nav>${content}</html>`;
}
