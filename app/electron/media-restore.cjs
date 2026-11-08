// Media-only consent scope. Never reads source credentials or opens a file picker.
function mediaRestore({vault,verify,close,activate,deactivate=()=>{},revision}){
 const states=new Map(),pending=new Map(),scopes=new Map();
 const state=root=>states.get(root)||{state:vault.hasKey(root,'media')?'savedUnverified':'unauthorized'};
 async function run(root,secret,save=false){
  states.set(root,{state:'verifying'});deactivate(root);
  try{
   const {entries,results}=await verify(root,secret);
   const available=Object.keys(entries).length>0;
   let saved=vault.hasKey(root,'media'),saveFailed=false;
   if(available){
    let previous={},persisted;try{persisted=vault.loadKey(root,'media');previous=JSON.parse(persisted||'{}')}catch{}
    if(!previous||typeof previous!=='object'||Array.isArray(previous))previous={};
    saved=!!persisted&&(secret===persisted||Object.entries(entries).every(([key,value])=>previous[key]===value));
    const scoped=JSON.stringify({...previous,...scopes.get(root),...entries});
    scopes.set(root,JSON.parse(scoped));
    if(save)try{vault.saveKey(root,scoped,'media');saved=true}catch{saveFailed=true}
    await close(root);activate(root,scoped);
    states.set(root,{state:results.some(r=>r.state!=='verified'&&r.state!=='missing')?'partial':saved&&!saveFailed?'ready':'temporary',results,saved,saveFailed});
    revision(root);
   }else states.set(root,{state:'unreadable',results,saved});
   return {available,results,saved:saved&&!saveFailed,saveFailed};
  }catch(error){states.set(root,{state:'unreadable',saved:vault.hasKey(root,'media')});throw error}
 }
 function restore(root){
  if(pending.has(root))return pending.get(root);
  if(!vault.hasKey(root,'media'))return Promise.resolve({available:false,results:[],saved:false});
  const task=Promise.resolve().then(()=>{const secret=vault.loadKey(root,'media');if(!secret)return {available:false,results:[],saved:false};return run(root,secret)}).catch(error=>{states.set(root,{state:vault.available?.()===false?'storageUnavailable':'unreadable',saved:vault.hasKey(root,'media')});throw error}).finally(()=>pending.delete(root));
  pending.set(root,task);return task;
 }
 return {state,restore,run};
}
module.exports={mediaRestore};
