export const SETTINGS_PANEL = `<style>
#settings-panel{overflow:auto;min-height:0;padding:28px 24px;flex:1}
#settings-panel .settings-content{max-width:700px;margin:0 auto}
#settings-panel .settings-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}
#settings-panel h1{font-size:23px}#settings-panel h2{font-size:13px;margin:0 0 16px}
#settings-panel p{margin:6px 0;color:#969fa9;font-size:12px;line-height:1.6}
#settings-panel .settings-section{padding:24px 0;border-bottom:1px solid #2c3035}
#settings-panel .setting-row+.setting-row{margin-top:20px}
#settings-panel label{display:block;font-size:12px;color:#cbd1d8;line-height:1.6}
#settings-panel .setting-control{display:flex;align-items:center;gap:8px;margin-top:7px}
#settings-panel select{min-width:0;max-width:100%;width:100%;text-overflow:ellipsis;padding:9px 10px}
#settings-panel .setting-control select{flex:1}#settings-panel .setting-control button{flex:none}
#settings-panel input:not([type=checkbox]),#settings-panel textarea{display:block;width:100%;margin-top:6px;padding:9px 10px}
#settings-panel input:focus-visible,#settings-panel textarea:focus-visible{outline:2px solid #a7d7bc;outline-offset:2px}
#settings-panel button{padding:8px 12px}#settings-panel button:disabled{opacity:.45;cursor:default}
#settings-panel .quiet-button{background:transparent;color:#a5aeb8;font-size:12px}
#settings-panel details{margin:0}#settings-panel summary{cursor:pointer;font-size:12px;color:#b1bac4;line-height:1.6}
#settings-panel .add-model{padding:20px 0}#settings-panel .add-model>summary{font-size:13px;color:#d8dee5;font-weight:550}
#settings-panel .add-body{padding-top:20px}#settings-panel .provider-details{margin-bottom:20px;padding:14px;background:#171a1d;border:1px solid #2c3035;border-radius:6px}
#settings-panel form{display:grid;gap:16px}#settings-panel form button[type=submit]{justify-self:start}
#settings-panel .provider-details[open]>summary{margin-bottom:16px}
#settings-panel .field-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
#settings-panel .check-label{display:flex;align-items:start;gap:8px}#settings-panel .check-label input{margin-top:4px}
#settings-panel .advanced{padding:12px 0;border-top:1px solid #2c3035}#settings-panel .advanced[open]>summary{margin-bottom:12px}
#settings-panel .model-item{padding:14px 0;border-top:1px solid #24282d}#settings-panel .model-item:first-child{border-top:0;padding-top:0}
#settings-panel .model-heading{display:flex;justify-content:space-between;align-items:start;gap:12px}
#settings-panel .model-name{font-size:13px;font-weight:500;overflow-wrap:anywhere;line-height:1.5}
#settings-panel .model-meta{font-size:11px;color:#949fa9;margin-top:4px}
#settings-panel .model-detail{margin-top:10px}#settings-panel .model-detail p{overflow-wrap:anywhere}
#settings-message:empty{display:none}#settings-panel #settings-message:not(:empty){margin:16px 0 0;padding:10px 12px;border-left:2px solid #a7d7bc;background:#19211d;color:#c8d7ce}
#settings-panel #settings-message[data-error=true]{border-color:#dfad80;color:#eccbad;background:#282119}
@media(max-width:480px){#settings-panel{padding:22px 16px}#settings-panel .field-pair{grid-template-columns:1fr}#settings-panel .model-heading{flex-wrap:wrap}}
</style>
<section id="settings-panel" role="tabpanel" aria-labelledby="settings-tab" hidden><div class="settings-content">
<div class="settings-heading"><h1>Models</h1><button id="settings-refresh" class="quiet-button">Refresh</button></div>
<p>Choose which model Pi uses for your work.</p><p id="settings-message" role="status" aria-live="polite"></p>
<section class="settings-section" aria-label="Model choices">
<div class="setting-row"><label for="model-default">Default for new projects</label><div class="setting-control"><select id="model-default"></select><button id="save-default">Save default</button></div></div>
<div class="setting-row" id="project-model-row"><label for="model-project">This project</label><div class="setting-control"><select id="model-project"></select><button id="save-project">Save choice</button></div><p id="project-model-description">Applies to future sessions. Work already started keeps its model.</p><p id="project-change-note" hidden>Review or stop active work first. Future worker context will be sent to the selected provider.</p></div>
</section>
<section class="settings-section"><h2>Saved models</h2><div id="model-list"></div></section>
<details class="add-model" id="add-model"><summary>Add a model</summary><div class="add-body">
<details class="provider-details" id="add-provider"><summary>Connect a new provider</summary>
<form id="connection-form"><label>Provider name<input name="name" required maxlength="100" placeholder="e.g. Mac Studio or Modal"></label><label>API base URL<input name="endpoint" type="url" required placeholder="http://127.0.0.1:8080/v1"></label>
<label>API key<input name="apiKey" type="password" autocomplete="off" placeholder="Stored privately on this Mac"></label><label class="check-label"><input name="noAuth" type="checkbox">No API key required</label>
<details class="advanced"><summary>Network options</summary><label class="check-label"><input name="allowInsecureHttp" type="checkbox">Allow unencrypted HTTP to a remote/LAN server</label><p>Remote HTTP exposes prompts and any key to the network. Localhost needs no extra permission.</p><p>Servers without authentication receive a non-secret placeholder bearer header.</p></details>
<button type="submit">Save provider</button></form></details>
<form id="profile-form"><div><label for="profile-connection">Provider</label><div class="setting-control"><select name="connectionId" id="profile-connection"></select><button type="button" id="discover-models">Find models</button></div></div>
<label>Model ID<input name="model" list="discovered-models" required maxlength="200" placeholder="Exact model name from your server"></label><datalist id="discovered-models"></datalist>
<label>Display name<input name="name" required placeholder="e.g. Local coding model" maxlength="100"></label>
<div><div class="field-pair"><label>Context window<input name="contextWindow" type="number" min="1" max="10000000" required placeholder="Tokens"></label><label>Maximum output<input name="maxTokens" type="number" min="1" max="10000000" required placeholder="Tokens"></label></div><p>Use the token limits configured on your model server.</p></div>
<details class="advanced"><summary>Advanced compatibility</summary><label class="check-label"><input name="reasoning" type="checkbox">Reasoning model</label><label>Compatibility overrides (JSON)<textarea name="compat" rows="4">{}</textarea></label></details>
<button type="submit">Save model</button></form></div></details>
<details class="advanced"><summary>How model settings work</summary><p>Start your OpenAI-compatible model server before connecting. Changing the default affects new projects only. Existing sessions keep their model, with no automatic fallback.</p><p>To change a saved endpoint, key or model configuration, add a replacement and select it for future work. Keys stay in private local files.</p></details>
</div></section>`;
export const SETTINGS_SCRIPT = `<script>
(()=>{
let csrf='',projectId=null,loaded=false,busy=false,savedDefault='',savedProject='';
const el=id=>document.getElementById(id);
const message=(s,error=false)=>{el('settings-message').textContent=s;el('settings-message').dataset.error=String(error);};
async function api(action,input){const r=await fetch('/settings'+(input===undefined?'?'+new URLSearchParams({workflowId:new URL(location.href).searchParams.get('workflowId')||''}):''),{method:input===undefined?'GET':'POST',headers:input===undefined?{}:{'Content-Type':'application/json','X-Pi-Settings':csrf},...(input===undefined?{}:{body:JSON.stringify({action,params:input})})});const d=await r.json();if(!r.ok)throw Error(d.error||'Settings request failed');return d;}
function option(id,label){const o=document.createElement('option');o.value=id;o.textContent=label;return o;}
function text(tag,value,cls){const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e;}
function choices(){el('save-default').disabled=busy||el('model-default').value===savedDefault;el('save-project').disabled=busy||el('model-project').value===savedProject;el('project-change-note').hidden=el('model-project').value===savedProject;}
async function load(){
 const d=await api();csrf=d.csrf;projectId=d.projectId;loaded=true;savedDefault=d.defaultProfileId;savedProject=d.projectProfileId||'';
 const connections=new Map(d.connections.map(c=>[c.id,c]));
 for(const id of ['model-default','model-project']){const select=el(id);select.replaceChildren(...d.profiles.map(p=>option(p.id,p.name+' · '+connections.get(p.connectionId).name)));select.value=id==='model-default'?savedDefault:savedProject;}
 const previous=el('profile-connection').value;el('profile-connection').replaceChildren(...d.connections.map(c=>option(c.id,c.name+(c.available?'':' · unavailable'))));if(connections.has(previous))el('profile-connection').value=previous;
 el('project-model-row').hidden=!projectId;
 const list=el('model-list');list.replaceChildren();
 for(const p of d.profiles){
  const c=connections.get(p.connectionId),row=text('div','','model-item'),head=text('div','','model-heading'),info=text('div',''),button=text('button','Test connection','quiet-button');
  info.append(text('div',p.name,'model-name'),text('div',c.name+' · '+(p.lastTest?(p.lastTest.ok?'Test passed':'Test failed'):'Not tested'),'model-meta'));
  button.onclick=()=>act(async()=>{message('Testing '+p.name+'…');const r=await api('test',{profileId:p.id});await load();message(r.detail,!r.ok);});head.append(info,button);
  const detail=text('details','','model-detail');detail.append(text('summary','Model details'),text('p','Model ID: '+p.model),text('p','Endpoint: '+c.endpoint),text('p',p.contextWindow.toLocaleString()+' context tokens · '+p.maxTokens.toLocaleString()+' output tokens'));
  row.append(head,detail);list.append(row);
 }
 if(!d.profiles.length){list.append(text('p','No models yet. Add one below.'));el('add-model').open=true;}
 if(!d.connections.length)el('add-provider').open=true;
 choices();
}
async function act(fn){if(busy)return;busy=true;for(const b of el('settings-panel').querySelectorAll('button'))b.disabled=true;try{await fn();}catch(e){message(e.message,true);}finally{busy=false;for(const b of el('settings-panel').querySelectorAll('button'))b.disabled=false;choices();}}
function id(){return crypto.randomUUID();}
document.addEventListener('pi-settings-open',()=>{if(!loaded)act(load);});el('settings-refresh').onclick=()=>act(async()=>{await load();message('Settings refreshed.');});
el('model-default').onchange=choices;el('model-project').onchange=choices;
el('save-default').onclick=()=>act(async()=>{await api('default',{profileId:el('model-default').value,requestId:id()});message('Default saved. Existing projects keep their model.');await load();});
el('save-project').onclick=()=>act(async()=>{await api('project',{projectId,profileId:el('model-project').value,requestId:id()});message('Project model saved for future sessions.');await load();});
const connectionForm=el('connection-form');connectionForm.elements.noAuth.onchange=()=>{connectionForm.elements.apiKey.disabled=connectionForm.elements.noAuth.checked;};
connectionForm.onsubmit=e=>{e.preventDefault();act(async()=>{const f=e.target,p={name:f.elements.name.value,endpoint:f.elements.endpoint.value,apiKey:f.elements.apiKey.value,noAuth:f.elements.noAuth.checked,allowInsecureHttp:f.elements.allowInsecureHttp.checked,requestId:id()};const result=await api('connection.add',p);f.elements.apiKey.value='';await load();el('profile-connection').value=result.connectionId;el('discovered-models').replaceChildren();el('add-provider').open=false;message('Provider saved. Enter its model details below.');el('profile-connection').focus();});};
el('profile-form').onsubmit=e=>{e.preventDefault();act(async()=>{const f=e.target;await api('profile.add',{connectionId:f.elements.connectionId.value,name:f.elements.name.value,model:f.elements.model.value,contextWindow:Number(f.elements.contextWindow.value),maxTokens:Number(f.elements.maxTokens.value),reasoning:f.elements.reasoning.checked,compat:JSON.parse(f.elements.compat.value),requestId:id()});await load();f.reset();el('discovered-models').replaceChildren();el('add-model').open=false;message('Model saved. Test its connection, then choose where to use it.');el('settings-message').scrollIntoView({block:'nearest'});});};
el('profile-connection').onchange=()=>el('discovered-models').replaceChildren();
el('discover-models').onclick=()=>act(async()=>{const d=await api('discover',{connectionId:el('profile-connection').value});el('discovered-models').replaceChildren(...d.models.map(m=>option(m,m)));message(d.models.length+' models found. Choose a model ID or type it yourself.');});
if(location.hash==='#settings')act(load);
})();
</script>`;
//# sourceMappingURL=model-settings-page.js.map