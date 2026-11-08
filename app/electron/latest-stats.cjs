const {Worker}=require('node:worker_threads');
const path=require('node:path');
// At most one running statistics worker and one latest intent. Obsolete intents never reach SQLite.
class LatestStats{
 constructor(database,ready=async()=>{}){this.database=database;this.ready=ready;this.active=null;this.stopping=Promise.resolve();this.closed=false}
 stop(job){
  Atomics.store(job.cancel,0,1);clearTimeout(job.timer);
  if(job.worker){const ended=job.worker.terminate();this.stopping=Promise.all([this.stopping,ended]).then(()=>{});}
 }
 cancel(id){
  const job=this.active;if(!job||job.id!==id)return false;
  this.active=null;this.stop(job);job.reject(Error('统计请求已取消'));return true;
 }
 run(id,args){
  if(this.closed)return Promise.reject(Error('统计服务已关闭'));
  if(typeof id!=='string'||!id.length||id.length>100)return Promise.reject(Error('统计请求标识无效'));
  if(this.active)this.cancel(this.active.id);
  return new Promise((resolve,reject)=>{
   const job={id,cancel:new Int32Array(new SharedArrayBuffer(4)),reject,worker:null,timer:null};this.active=job;
   const finish=(error,value)=>{
    if(this.active!==job)return;
    this.active=null;this.stop(job);error?reject(error):resolve(value);
   };
   job.timer=setTimeout(()=>finish(Error('统计操作超时，请重试。')),600000);
   (async()=>{
    await this.stopping;await this.ready();if(this.active!==job)return;
    const worker=job.worker=new Worker(path.join(__dirname,'archive-view-worker.cjs'),{workerData:{database:this.database,cancel:job.cancel,derivedWrites:true}});
    worker.on('message',m=>finish(m.error?Error(m.error):null,m.value));
    worker.on('error',()=>finish(Error('统计服务异常，请重试。')));
    worker.on('exit',()=>finish(Error('统计服务已停止，请重试。')));
    worker.postMessage({id:1,method:'stats',args});
   })().catch(()=>finish(Error('统计服务启动失败，请重试。')));
  });
 }
 close(){this.closed=true;if(this.active)this.cancel(this.active.id);return this.stopping}
}
module.exports={LatestStats};
