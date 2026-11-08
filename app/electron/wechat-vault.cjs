const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {app,safeStorage}=require('electron');

function keyPath(root,scope){
 const id=createHash('sha256').update(root).digest('hex');
 return path.join(app.getPath('userData'),'wechat-keys',id+(scope==='media'?'.media':'')+'.enc');
}
function available(){return process.platform==='darwin'&&safeStorage.isEncryptionAvailable();}
function hasKey(root,scope){return fs.existsSync(keyPath(root,scope));}
function saveKey(root,key,scope){
 if(!available())throw Error('系统安全存储不可用。');
 const target=keyPath(root,scope),temp=target+'.'+randomUUID()+'.tmp';
 fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
 try{
  fs.writeFileSync(temp,safeStorage.encryptString(key),{mode:0o600,flag:'wx'});
  fs.renameSync(temp,target);
 }finally{fs.rmSync(temp,{force:true});}
}
function loadKey(root,scope){
 if(!available()||!hasKey(root,scope))throw Error('没有可用的已保存密钥。');
 try{return safeStorage.decryptString(fs.readFileSync(keyPath(root,scope)));}
 catch{throw Error('无法从系统安全存储读取密钥。请重新填写。');}
}
function clearKey(root){fs.rmSync(keyPath(root),{force:true});}
module.exports={available,hasKey,saveKey,loadKey,clearKey};
