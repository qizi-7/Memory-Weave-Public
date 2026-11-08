const {parentPort,workerData}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
const {ArchiveViews}=require('./archive-views.cjs');
const db=new DatabaseSync(workerData.database,{readOnly:workerData.derivedWrites!==true,timeout:3000});
const views=new ArchiveViews(db,{persist:workerData.derivedWrites===true});
const {prepareProjection}=require('./archive-projection.cjs');
let serial=Promise.resolve();
parentPort.on('message',message=>{serial=serial.then(()=>handle(message))});
async function handle({id,method,args}){
 try{
  let value;
  if(workerData.derivedWrites===true&&method==='stats')await prepareProjection(db,{cancelled:()=>!!workerData.cancel&&Atomics.load(workerData.cancel,0)!==0});
  if(method==='mediaIndex'||method==='statMessages')value=views.browse(args,method==='mediaIndex'?'media':'stat');
  else if(['directory','stats','favorites','diagnostics'].includes(method))value=views[method](args);
  else throw Error('unknown operation');
  parentPort.postMessage({id,value});
 }catch(error){
  const safe=error.code?.startsWith('ERR_SQLITE')?(error.errcode===5||error.errcode===6?'工作库正在忙，请稍后重试。':error.errcode===11?'工作库结构或内容损坏，未自动重建。':'工作库查询失败，请重试。'):error.message;
  parentPort.postMessage({id,error:safe});
 }
}
