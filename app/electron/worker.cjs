const {parentPort,workerData}=require('node:worker_threads');
const {Store}=require('./store.cjs');
const fs=require('node:fs');
const {publicMessage}=require('./message-content.cjs');
const store=new Store(workerData.database,{messagesCommitted:commit=>parentPort.postMessage({commit})});
const {AI}=require('./ai.cjs');const ai=new AI(store);
const {importWeChat}=require('./wechat-adapter.cjs');
const media=new (require('./wechat-media-db.cjs').WeChatMediaDB)(workerData.helper);
const jobs=new Map();
function syncControl(id){
 const control={state:'running',wake:null};
 control.wait=async()=>{
  while(control.state==='paused')await new Promise(resolve=>{control.wake=resolve});
  if(control.state==='cancelled')throw Object.assign(Error('同步已取消，已提交的数据和断点已保留。'),{code:'SYNC_CANCELLED'});
 };
 jobs.set(id,control);
 return control;
}
parentPort.on('message',async({id,method,args})=>{
  if(method==='syncControl'){
    const job=jobs.get(id);
    if(job){job.state=args;job.wake?.();job.wake=null;}
    return;
  }
  try {
    let value;
    if(method==='syncInterrupted'||method==='hasSyncWindow'){
      const exists=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='wechat_sync_window'").get();
      const window=exists&&store.db.prepare('SELECT account FROM wechat_sync_window ORDER BY rowid DESC LIMIT 1').get();
      if(method==='hasSyncWindow')value=!!(exists&&store.db.prepare('SELECT 1 FROM wechat_sync_window WHERE account=?').get(args));
      else value=window?{id:0,account:window.account,state:'cancelled',ready:false,stage:'检测到未完成的同步，可在设置中继续。'}:null;
    }
    else if(method==='queryDiagnostics'){
      const exists=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='wechat_query_diagnostics'").get();
      const errors=exists?store.db.prepare('SELECT * FROM wechat_query_diagnostics ORDER BY occurred_at DESC LIMIT 20').all():[];
      const hasRetry=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='wechat_sync_retry'").get();
      const {sourceId}=require('./wechat-sync-retry.cjs');
      const pending=hasRetry?store.db.prepare('SELECT source,phase,checkpoint,row_id,kind FROM wechat_sync_retry WHERE resolved_at IS NULL ORDER BY updated_at DESC LIMIT 100').all().map(({source,...item})=>({sourceId:sourceId(source),...item})):[];
      const hasGaps=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='wechat_sync_gaps'").get();
      const gaps=hasGaps?store.db.prepare('SELECT source,phase,row_id,kind,state,attempts FROM wechat_sync_gaps WHERE resolved_at IS NULL ORDER BY updated_at DESC LIMIT 100').all().map(({source,...item})=>({sourceId:sourceId(source),...item})):[];
      const discrepancies=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='wechat_source_discrepancy'").get()?store.db.prepare('SELECT source_id,kind,first_seen,last_seen,affected FROM wechat_source_discrepancy ORDER BY last_seen DESC LIMIT 100').all():[];
      value={errors,pending,gaps,discrepancies};
    }
    else if(method==='saveFavorite')value=require('./archive-views.cjs').saveFavorite(store.db,args);
    else if(method==='verifySource')value=await importWeChat(store,{...args,verifyOnly:true},workerData.helper);
    else if(method==='mediaClose')value=await media.close(args);
    else if(method==='mediaVerify')value=await media.verify(args.root,args.secret);
    else if(method==='mediaAvatar')value=await media.avatar(args.root,args.secret,args.username);
    else if(method==='mediaLocateDetailed')value=await media.locateDetailed(args.root,args.secret,args.row,args.slot,{sourceSecret:args.sourceSecret});
    else if(method==='mediaLocate')value=await media.locate(args.root,args.secret,args.row,args.slot);
    else if(method==='mediaVoice')value=await media.voice(args.root,args.secret,args.row);
    else if(method==='aiStatus')value=await ai.status(args);
    else if(method==='aiIndex')value=await ai.index(args);
    else if(method==='aiSearch')value=await ai.search(args);
    else if(method==='aiAsk')value=await ai.ask(args);
    else if(method==='connectWeChat') {try{value=await importWeChat(store,args,workerData.helper,progress=>parentPort.postMessage({id,progress}),args.background?syncControl(id):undefined);}catch(e){throw Object.assign(Error(e.message+(e.imported>0?` 本次已保留 ${e.imported} 条新消息，重试会自动去重。`:'')),{code:e.code});}finally{args.key='';jobs.delete(id);}}
    else if(method==='exportFile') {
      const rows=store.exportData(args);
      const body=args.format==='json'?JSON.stringify(rows,null,2):rows.map(m=>`### ${new Date(m.ts*1000).toISOString()} · ${m.sender}\n\n${m.text.replace(/([\\`*_[\]<>#])/g,'\\$1')}\n${m.note?'\n备注：'+m.note+'\n':''}`).join('\n');
      fs.writeFileSync(args.file,body,{mode:0o600});value={count:rows.length};
    } else if(['messages','find','changes'].includes(method)){
      const rows=store[method](args),hasFavorites=method==='messages'&&store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_favorites'").get();
      const saved=hasFavorites&&store.db.prepare('SELECT 1 FROM local_favorites WHERE account=? AND message_id=?');
      value=rows.map(row=>publicMessage({...row,...(method==='messages'?{favorited:!!(saved&&saved.get(row.account,row.id))}:{})}));
    }
    else if(['accounts','importFile','contacts','sessions','mediaMessage','edit','undo','locate','stats'].includes(method)) value=store[method](args);
    else throw Error('不支持的操作');
    parentPort.postMessage({id,value});
  } catch(e){parentPort.postMessage({id,error:e.message,code:e.code});}
});
