// Isolated fault-injection daemon. Never uses credentials or the configured provider.
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { PiDurableService } from '../../src/service.js';
const dir=process.argv[2]!;
const faux=fauxProvider({provider:'faux',models:[{id:'fixture'}]});
const models=createModels();models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage(fauxToolCall('bash',{command:'printf "once\\n" >> crash-marker.txt; sleep 1'}),{stopReason:'toolUse'}),fauxAssistantMessage('Completed')]);
const service=await PiDurableService.start({transport:'none',host:{runtimeDir:join(dir,'state'),config:{configVersion:1,endpoint:'https://example.invalid/v1',model:'fixture',limits:{contextWindow:65536,maxTokens:8192,maxSteps:null,timeoutMs:null},paths:{stateDir:join(dir,'state'),projectHome:join(dir,'projects'),allowedRoots:[join(dir,'projects')]},credential:{env:'UNUSED_FIXTURE'},manager:{enabled:false}},providerId:'faux',createModels:()=>models,resolveCredential:async()=>({apiKey:'fixture-key-unused',source:'test'}),unsandboxedForTesting:true}});
process.on('message',async(m:any)=>{
 if(m.method==='fixture.stop'){await service.stop();process.send?.({id:m.id,result:true},()=>process.exit(0));return;}
 const r=await service.handle({v:1,id:m.id,method:m.method,params:{...m.params,requestId:m.id}} as any);
 process.send?.(r);
});
process.send?.({ready:true});
