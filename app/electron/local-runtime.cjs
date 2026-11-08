const fs=require('node:fs/promises');const path=require('node:path');const {spawn}=require('node:child_process');const {jsonRequest}=require('./ai.cjs');
let owned;
async function ensureRuntime(resources,userData){
 try{await jsonRequest(require('./app-identity.cjs').aiBase,'/api/version',undefined,1500);return {running:true,owned:false};}catch{}
 const modelDir=path.join(userData,'models'),seed=path.join(resources,'models');
 const executable=path.join(resources,'ollama','ollama');
 try{await Promise.all([fs.access(executable),fs.access(seed)]);}catch{throw Error('未检测到本地 Ollama。请在 127.0.0.1:11449 启动 Ollama 并安装所需模型。');}
 // On first use copy bundled, verified model files to the app's writable data directory.
 await fs.mkdir(modelDir,{recursive:true,mode:0o700});
 await fs.cp(seed,modelDir,{recursive:true,force:false,errorOnExist:false});
 owned=spawn(executable,['serve'],{env:{...process.env,OLLAMA_HOST:require('./app-identity.cjs').aiHost,OLLAMA_MODELS:modelDir,OLLAMA_NO_CLOUD:'1'},stdio:'ignore'});
 let error;owned.once('error',e=>{error=e;});
 const deadline=Date.now()+20000;
 while(Date.now()<deadline){if(error)throw Error('本地 AI 运行时启动失败');try{await jsonRequest(require('./app-identity.cjs').aiBase,'/api/version',undefined,1000);return {running:true,owned:true};}catch{}await new Promise(r=>setTimeout(r,250));}
 owned.kill();throw Error('本地 AI 运行时启动超时');
}
function stopRuntime(){owned?.kill();owned=null;}
module.exports={ensureRuntime,stopRuntime};
