const fs=require('node:fs');
// Connection options contain personal identifiers but never credentials. Stored locally with 0600.
function retryContexts(file){
 let entries={};try{const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value&&typeof value==='object'&&!Array.isArray(value))entries=value;}catch{}
 const options=input=>({profile:['3','4','auto'].includes(input.profile)?input.profile:'auto',selfId:typeof input.selfId==='string'?input.selfId:'',displayName:typeof input.displayName==='string'?input.displayName:'',allowDecrypted:input.allowDecrypted===true});
 const write=()=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(entries),{mode:0o600});fs.renameSync(tmp,file)};
 return {
  roots:()=>Object.keys(entries),
  get:root=>({...options(entries[root]||{}),...(entries[root]?.retrySourceId?{retrySourceId:entries[root].retrySourceId,retryFailed:true}:{})}),
  save(input){entries[input.root]={...options(input),...(input.retrySourceId?{retrySourceId:input.retrySourceId}:{})};write()},
  target(root,id){if(id!==undefined&&!/^[a-f0-9]{12}$/.test(id))throw Error('重试目标无效');entries[root]={...options(entries[root]||{}),...(id?{retrySourceId:id}:{})};write()},
  finish(root){if(entries[root]){delete entries[root].retrySourceId;write()}},
 };
}
// Only database scope may authorize a database read. Media credentials are deliberately absent.
function sourceCredential(root,sourceKeys,vault){if(sourceKeys.has(root))return sourceKeys.get(root);if(vault.hasKey(root))return vault.loadKey(root);return '';}
module.exports={retryContexts,sourceCredential};
