const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawn}=require('node:child_process');const {zstdDecompressSync}=require('node:zlib');
const {openBatchReader}=require('./wechat-batch-reader.cjs');
const {createSnapshot}=require('./wechat-snapshot.cjs');
const {readLocalAccountIdentity,accountDirectoryBelongsToIdentity}=require('./wechat-profile-identity.cjs');
const {keysForDatabases}=require('./wechat-keys.cjs');
const {openGaps,identity:gapIdentity}=require('./wechat-sync-gaps.cjs');
const {sourceId,openRetryQueue,retryableRead,pageLimits,growBatch}=require('./wechat-sync-retry.cjs');
const ident=s=>'"'+s.replaceAll('"','""')+'"';
function readQuery(helper,file,key,profile,sql,{privateCopy=false}={}){return new Promise((resolve,reject)=>{
 const child=spawn(helper,privateCopy?[file,'--private-copy']:[file],{stdio:['pipe','pipe','pipe']});let output='',error='',done=false;
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 const timer=setTimeout(()=>{child.kill();finish(Error('数据库读取超时'));},45000);
 function finish(err,value){if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(value);}
 child.on('error',()=>finish(Error('本机只读数据库读取器无法启动')));
 child.stdout.on('data',b=>{output+=b.toString('utf8');if(Buffer.byteLength(output)>64*1024*1024){child.kill();finish(Error('查询结果过大，请分批导入'));}});
 child.stderr.on('data',b=>{error+=b.toString().slice(0,1000)});
 child.on('close',code=>{if(error.includes('KEY_OR_SCHEMA'))return finish(Object.assign(Error('数据库密钥、加密配置或结构不匹配。'),{code:'DB_FORMAT'}));if(code!==0)return finish(Error(error.includes('ACTIVE_WAL')?'检测到未合并 WAL。请正常退出微信后重试，或选择已完成的一致备份。':'只读数据库读取失败（'+code+'）'));try{finish(null,output.trim()?output.trim().split('\n').map(JSON.parse):[])}catch{finish(Error('读取器返回的数据无法解析'));}});
 child.stdin.on('error',()=>{});child.stdin.end(key+'\n'+profile+'\n'+sql);
});}
function text(v){if(Buffer.isBuffer(v)||v&&typeof v==='object'&&typeof v.$hex==='string'){let b=Buffer.isBuffer(v)?v:Buffer.from(v.$hex,'hex');if(b.length>=4&&b.readUInt32LE(0)===0xfd2fb528){if(!zstdDecompressSync)throw Error('本机运行时不支持 zstd 解压');b=zstdDecompressSync(b,{maxOutputLength:8*1024*1024});}return new TextDecoder('utf-8',{fatal:true}).decode(b);}return v==null?'':String(v);}
function normalize(row,context){
 const time=Number(row.create_time??row.msgCreateTime??NaN);const local=String(row.local_id??row.mesLocalID??row.__rowid??'');
 if(!Number.isSafeInteger(time)||time<0||time>8640000000000||!local)throw Error('消息缺少有效时间或稳定 ID，已停止该批导入');
 let body=text(row.message_content??row.msgContent??row.content??'');
 const compressed=row.compress_content??row.compressed_content;if(!body&&compressed)body=text(compressed);
 let sender=text(row.sender_username??row.sender??'');
 if(!sender&&row.real_sender_id!=null)sender=context.senders.get(String(row.real_sender_id))||'';
 const match=body.match(/^([^\s:<]{1,200}):\n/);if(!sender&&match)sender=match[1];
 if(context.chat.endsWith('@chatroom')&&match&&sender===match[1])body=body.slice(match[0].length);
 const flag=row.is_send??row.isSend;
 const outgoing=flag!=null?Number(flag)===1:sender===context.self;
 if(!sender)sender=outgoing?context.self:context.chat;
 let type;try{type=Number(BigInt(row.local_type??row.message_type??row.msgType??1)&0xffffffffn)}catch{type=0}
 const kind=({1:'text',3:'image',34:'voice',43:'video',49:'link',10000:'system',10002:'system'})[type]||'system';
 return {id:`${context.relative}:${context.table}:${local}`,chat:context.chat,sender,timestamp:time,text:body,outgoing,kind};
}
function readMatchingIdentity(accountRoot){
 const identity=readLocalAccountIdentity(path.dirname(accountRoot));
 return identity&&accountDirectoryBelongsToIdentity(path.basename(accountRoot),identity.wxid)?identity:null;
}
async function importWeChat(store,{root,key='',profile='auto',selfId='',displayName,allowDecrypted=false,verifyOnly=false,retryFailed=false,retrySourceId,incremental=false,incrementalSourceId,grantId,forceCheck=false,auditMode,trace},helper,onProgress=()=>{},control){
 if(typeof root!=='string'||!['auto','3','4'].includes(profile)||typeof selfId!=='string'||selfId.length>200)throw Error('请输入有效的数据库密钥和兼容配置');
 if(!key&&allowDecrypted!==true)throw Error('请输入数据库密钥；只有明确选择已解密副本时才可留空。');
 if(incremental&&(!control||retryFailed||verifyOnly))throw Error('日常增量模式不能与历史重试或验证模式混用。');
 const keyFor=keysForDatabases(key,allowDecrypted);
 const canonical=fs.realpathSync(root);const data=path.join(canonical,'db_storage');if(!fs.existsSync(data))throw Error('请选择包含 db_storage 的单个微信账号目录');
 const timings={sourceStamp:0,snapshotWal:0,contacts:0,openSchema:0,name2id:0,anchors:0,workspace:0,audit:0,openSchemaBySource:{}};
 const timed=async(kind,fn)=>{const t=performance.now();try{return await fn()}finally{timings[kind]+=performance.now()-t}};
 const local=fn=>{const t=performance.now();try{return fn()}finally{timings.workspace+=performance.now()-t}};
 const account={id:'wechat:'+crypto.createHash('sha256').update(canonical).digest('hex'),name:displayName?.trim()||'微信本地账号'};
 const {openIntegrity,week}=require('./wechat-integrity.cjs');
 const integrity=incremental?local(()=>openIntegrity(store.db,account.id)):null;
 const {sourceManifest}=require('./auto-sync.cjs');
 const captureStamp=()=>{const t=performance.now();try{return sourceManifest(canonical)}finally{timings.sourceStamp+=performance.now()-t}};
 const receipt=integrity&&local(()=>integrity.receipt());
 const eligible=!!(integrity&&grantId&&!incrementalSourceId);
 const manifest=eligible?captureStamp():null,stamp=manifest?.stamp;
 const fullAudit=auditMode==='full'||!!(eligible&&receipt&&Date.now()>=receipt.audit_due);
 if(eligible&&!forceCheck&&!fullAudit&&receipt?.grant_id===grantId&&receipt.stamp===stamp&&captureStamp().stamp===stamp){
  const pending=local(()=>openRetryQueue(store.db,account.id).pending());
  if(!pending.some(item=>item.phase==='incremental')){
   const integrityIssues=local(()=>integrity.count()),historicalPending=pending.length;
   return {account:account.id,selfId,name:account.name,incremental:true,unchanged:true,verifiedAt:receipt.verified_at,failedTables:0,added:0,scanned:0,integrityIssues,historicalPending,timings,warnings:integrityIssues?[`有 ${integrityIssues} 项来源差异待人工核对。`]:[]};
  }
 }
 let previousFiles=null;
 if(eligible&&!forceCheck&&!fullAudit&&receipt?.grant_id===grantId&&receipt.manifest)try{previousFiles=JSON.parse(receipt.manifest)}catch{}
 const reuseContacts=!!(selfId.trim()&&previousFiles?.['contact/contact.db']&&previousFiles['contact/contact.db']===manifest?.files['contact/contact.db']
  &&local(()=>store.db.prepare('SELECT 1 FROM contacts WHERE account=? LIMIT 1').get(account.id)));
 const identity=readMatchingIdentity(canonical);
 if(!displayName?.trim()&&identity?.nickname)account.name=identity.nickname;
 const files=fs.readdirSync(path.join(data,'message')).filter(n=>/^message_\d+\.db$/.test(n)).sort();
 if(!files.length){
  for(const missing of integrity?.tracked()||[])if(missing.startsWith('message/'))integrity.note(missing,'SOURCE_FILE_MISSING');
  throw Object.assign(Error('账号目录中没有受支持的 message_<n>.db'),incremental?{code:'SOURCE_CHANGED'}:{});
 }
 onProgress({stage:"正在复制并校验数据库和日志"});
 let batch,batchFile,queryCount=0,maxResponseBytes=0,queryMs=0;
 const snapshots=new Map();
 const contactFile='contact/contact.db';
 let added=0,scanned=0,checkpointScanned=0,deduplicated=0,databases=0,skipped=0,recovered=0,oversized=0;
 let completedIncremental=0;
 const failedSources=new Set();const warnings=[];
 const schemaSql="SELECT name FROM sqlite_master WHERE type='table'";
 const gate=()=>control?.wait();
 const snapshotFor=async relative=>{
  await gate();
  if(!snapshots.has(relative)){
   onProgress({stage:'正在校验数据库副本',file:relative,account:account.id,scanned,added,skipped});
   const snapshot=await timed('snapshotWal',()=>createSnapshot(data,[relative]));snapshots.set(relative,snapshot);
   if(integrity&&!integrity.check(relative,snapshot.identities[relative])){
    integrity.note(relative,'SOURCE_FILE_REPLACED_OR_SALT_CHANGED');
    throw Object.assign(Error('源数据库文件或 Salt 已变化，已保留现有归档。'),{code:'SOURCE_CHANGED'});
   }
  }
  return snapshots.get(relative);
 };
 const filename=relative=>path.join(snapshots.get(relative).root,relative);
 try{
 const modes=profile==='auto'?['4','3']:[profile];
 const canDerive=Boolean(key.trim());
 const openModes=new Map();
 let preferred;
 const read=(relative,sql,mode,rawKey)=>readQuery(helper,filename(relative),rawKey,mode,sql,{privateCopy:true});
 const openSchema=async relative=>{
  await snapshotFor(relative);
  const rawKey=keyFor(relative,filename(relative));
  const attempts=(canDerive?[false,true]:[false]).flatMap(derive=>modes.map(mode=>({derive,mode})));
  if(preferred){
   const index=attempts.findIndex(attempt=>attempt.derive===preferred.derive&&attempt.mode===preferred.mode);
   if(index>0)attempts.unshift(...attempts.splice(index,1));
  }
  for(const {derive,mode} of attempts){
   let candidate=rawKey;
   if(derive&&!keyFor.derived){
    const salt=Buffer.alloc(16);
    const fd=fs.openSync(filename(relative),'r');
    try{if(fs.readSync(fd,salt,0,16,0)!==16)throw Error('数据库文件头不完整：'+relative);}
    finally{fs.closeSync(fd);}
    candidate=crypto.pbkdf2Sync(Buffer.from(rawKey,'hex'),salt,mode==='4'?256000:64000,32,mode==='4'?'sha512':'sha1').toString('hex');
   }
   try{
    const id=sourceId(relative),started=performance.now();
    const rows=await timed('openSchema',async()=>{try{return await read(relative,schemaSql,mode,candidate)}finally{
     timings.openSchemaBySource[id]=(timings.openSchemaBySource[id]||0)+performance.now()-started;
    }});
    if(integrity)integrity.remember(relative,snapshots.get(relative).identities[relative]);
    openModes.set(relative,{mode,key:candidate});
    preferred={derive,mode};
    return rows;
   }catch(e){if(e.code!=='DB_FORMAT')throw e;}
  }
  throw Object.assign(Error('数据库密钥或兼容配置不匹配。'),{code:'DB_FORMAT'});
 };
 onProgress({stage:"正在验证通讯录密钥"});
 let contactRows;
 try{contactRows=reuseContacts?[]:await openSchema(contactFile);}
 catch(e){
  if(e.code!=='DB_FORMAT')throw e;
  throw Object.assign(Error('无法打开通讯录数据库。请核对 contact/contact.db 对应的密钥。若各库密钥不同，请粘贴逐库密钥 JSON。已尝试的兼容模式：'+modes.join('、')+'。'),{code:'DB_FORMAT'});
 }
 if(verifyOnly){
  const file=files.reduce((smallest,file)=>fs.statSync(path.join(data,'message',file)).size<fs.statSync(path.join(data,'message',smallest)).size?file:smallest);
  const schema=await openSchema('message/'+file);
  if(!contactRows.some(row=>/^contact$/i.test(row.name))||!schema.some(row=>/^(Msg|Chat)_[a-f0-9]{32}$/i.test(row.name)))throw Error('已打开数据库，但没有找到受支持的聊天分表。');
  return {account:account.id,name:account.name,verifiedAt:Date.now(),sourceReadable:true};
 }
 const query=async(relative,sql)=>{
  await gate();
  if(batchFile!==relative){
   if(batch)await batch.close();
   const {key,mode}=openModes.get(relative);
   batch=openBatchReader(helper,filename(relative),key,mode);
   batchFile=relative;
  }
  const started=Date.now();
  try{const rows=await batch.query(sql);queryCount++;maxResponseBytes=Math.max(maxResponseBytes,batch.responseBytes);queryMs+=Date.now()-started;return rows;}
  catch(error){
   await batch.close();
   batch=null;batchFile=null;
   error.queryFailure=true;
   error.elapsedMs=Date.now()-started;
   throw error;
  }
 };
 let diagnostics,detail,retries,gaps;
 if(control){
  store.db.exec(`CREATE TABLE IF NOT EXISTS wechat_sync_errors (account TEXT, source TEXT, phase TEXT, page_limit INTEGER, rows INTEGER, bytes INTEGER, elapsed_ms INTEGER, kind TEXT, occurred_at INTEGER);
   CREATE TABLE IF NOT EXISTS wechat_query_diagnostics (module TEXT, source_id TEXT, phase TEXT, page_limit INTEGER, rows INTEGER, bytes INTEGER, elapsed_ms INTEGER, kind TEXT, checkpoint TEXT, occurred_at INTEGER)`);
  retries=openRetryQueue(store.db,account.id);
  gaps=openGaps(store.db,account.id);
  diagnostics=store.db.prepare('INSERT INTO wechat_sync_errors VALUES(?,?,?,?,?,?,?,?,?)');
  detail=store.db.prepare('INSERT INTO wechat_query_diagnostics VALUES(?,?,?,?,?,?,?,?,?,?)');
 }
 let errors=0,consecutiveFailures=0;
 let targets;
 let savedBefore;
 const recordError=(error,context,limit,elapsed)=>{
  errors++;if(!error.rowGap&&error.code!=='SOURCE_CHANGED')consecutiveFailures++;
  if(!diagnostics)return;
  const now=Date.now(),kind=error.diagnosticCode||error.code||'QUERY_FAILED';
  diagnostics.run(account.id,context.source,context.phase,limit,error.rows??0,error.bytes??0,elapsed,kind,now);
  detail.run('wechat-sync/reader',sourceId(context.source),context.phase,limit,error.rows??0,error.bytes??0,elapsed,kind,context.checkpoint??null,now);
 };
 const circuitOpen=()=>consecutiveFailures>=12;
 const checkCircuit=()=>{
  if(circuitOpen())throw Object.assign(Error('连续 12 次读取失败，已停止同步并保留检查点。'),{code:'SYNC_CIRCUIT_OPEN'});
 };
 const adaptivePage=async(read,initialLimit,context)=>{
  const limits=pageLimits(initialLimit);
  for(const limit of limits){
   const started=Date.now();
   try{return {...await read(limit,'normal'),limit};}
   catch(error){
    if(!error.queryFailure)throw error;
    recordError(error,context,limit,Date.now()-started);
    error.recorded=true;
    const canSplit=retryableRead.has(error.code);
    if(!canSplit||circuitOpen())throw error;
    if(limit>1){
     onProgress({stage:'正在用更小的源库 SQL 批次重试',account:account.id,scanned,added,errors,batchSize:limit,queryCount,maxResponseBytes,queryMs});
     continue;
    }
    if(!context.isolateRow)throw error;
    if(['ROW_OVERSIZE','ROW_BYTES','PAGE_BYTES'].includes(error.code)){
     try{return {...await read(1,'single'),limit:1};}
     catch(singleError){
      if(!singleError.queryFailure)throw singleError;
      recordError(singleError,context,1,Date.now()-started);
      singleError.recorded=true;
      error=singleError;
     }
    }
    if(!error.rowId&&!circuitOpen()){
     try{error.rowId=(await read(1,'identity')).cursorRows[0]?.__rowid;}
     catch(identityError){
      if(!identityError.queryFailure)throw identityError;
      recordError(identityError,context,1,Date.now()-started);
     }
    }
    if(error.rowId&&['ROW_BYTES','ROW_OVERSIZE','ROW_CONTENT','NATIVE_READ','BRIDGE_JSON','BRIDGE_UTF8'].includes(error.code))return {...await read(1,'gap'),limit:1};
    throw error;
   }
  }
 };
 const queryPage=(relative,sql,limit,context={source:relative,phase:'metadata'})=>
  adaptivePage(async size=>({rows:await query(relative,sql(size))}),limit,context);
 if(retries&&retryFailed){
  if(!retries.pending().some(item=>item.phase!=='incremental'))retries.seedLegacy();
  const pending=retries.pending().filter(item=>item.phase!=='incremental');
  targets=retrySourceId?pending.filter(item=>sourceId(item.source)===retrySourceId):pending;
  if(retrySourceId&&!targets.length)throw Error('未找到该分表的待重试记录。');
  if(!targets.length)targets=undefined;
 }
 if(incrementalSourceId){
  if(!incremental||!/^[a-f0-9]{12}$/.test(incrementalSourceId))throw Error('增量重试目标无效。');
  targets=retries.pending().filter(item=>item.phase==='incremental'&&sourceId(item.source)===incrementalSourceId);
  if(!targets.length)throw Error('未找到该增量分表的待重试记录。');
 }
 const selectedSources=targets&&new Set(targets.map(item=>item.source));
 const selectedPhases=targets&&new Set(targets.map(item=>item.source+':'+item.phase));
 let selectedFiles=selectedSources?files.filter(file=>[...selectedSources].some(source=>source==='message/'+file||source.startsWith('message/'+file+':'))):files;
 if(previousFiles&&receipt.stamp!==stamp){
  const previous=previousFiles;
  // Only use selective refresh with a known, unchanged contact directory and explicit self identity.
  if(reuseContacts){
   const retrying=retries.pending().filter(item=>item.phase==='incremental').map(item=>item.source.split(':')[0]);
   const changed=selectedFiles.filter(file=>previous['message/'+file]!==manifest.files['message/'+file]||retrying.includes('message/'+file));
   selectedFiles=changed;
  }
 }
 if(targets&&!selectedFiles.length)throw Error('待重试的消息分库在源目录中不存在。');
 if(control&&!incremental)savedBefore=local(()=>store.db.prepare('SELECT count(*) AS n FROM messages WHERE account=?').get(account.id).n);
 const table=contactRows.map(r=>r.name).find(n=>/^contact$/i.test(n));if(!table&&!reuseContacts)throw Error('未识别到微信 4.x contact 表');
 async function* scanRows(relative,table){
  let cursor;
  for(;;){
   const where=cursor===undefined?'':' WHERE rowid > '+cursor;
   const {rows,limit}=await queryPage(relative,n=>`SELECT rowid AS __rowid,* FROM ${ident(table)}${where} ORDER BY rowid LIMIT ${n}`,1000);
   if(!rows.length)return;
   yield* rows;
   if(rows.length<limit)return;
   cursor=String(rows.at(-1).__rowid);
   if(!/^-?\d+$/.test(cursor))throw Error('数据库分页标识无效：'+relative);
  }
 }
 onProgress({stage:"通讯录密钥已通过，正在读取联系人"});
 const contacts=new Map(),byHash=new Map();
 await timed('contacts',async()=>{
 if(reuseContacts){
  for(const {id,name} of local(()=>store.contacts(account.id))){contacts.set(id,{id,name});byHash.set(crypto.createHash('md5').update(id).digest('hex'),id);}
  return;
 }
 for await(const row of scanRows(contactFile,table)){
  const id=text(row.username??row.user_name??row.m_nsUsrName);
  if(!id)continue;
  const name=text(row.remark??row.remark_name)||text(row.nick_name??row.nickname??row.m_nsNickName)||id;
  contacts.set(id,{id,name});
  byHash.set(crypto.createHash('md5').update(id).digest('hex'),id);
 }
 });
 let resolvedSelf=selfId.trim()||identity?.wxid;
 let sourceVerified=false,verifiedAt;
 const readMessageInfo=async file=>{
  const relative='message/'+file;
  onProgress({stage:'正在验证并读取消息分库',file,total:files.length,scanned,added,skipped});
  let meta;
  try {meta=await openSchema(relative);}
  catch(e){if(e.code==='DB_FORMAT')throw Object.assign(Error('通讯录库已打开，但无法打开消息分库。该分库可能使用不同的密钥或加密配置。'),{code:'DB_FORMAT'});throw e;}
  if(!sourceVerified&&meta.some(row=>/^(Msg|Chat)_[a-f0-9]{32}$/i.test(row.name))){
   sourceVerified=true;verifiedAt=Date.now();
   onProgress({stage:'微信源库与密钥已验证',sourceVerified:true,account:account.id,name:account.name,verifiedAt,scanned,added,skipped});
  }
  const nameTable=meta.map(r=>r.name).find(n=>/^Name2Id/i.test(n));
  const senders=new Map();
  if(nameTable)await timed('name2id',async()=>{
   for await(const row of scanRows(relative,nameTable)){
    senders.set(String(row.__rowid),text(row.user_name??row.username));
   }
  });
  return {relative,meta,senders};
 };
 const checked=new Map();
 if(!resolvedSelf){
  const directory=path.basename(canonical);
  const candidates=[directory,directory.replace(/_[a-z0-9]{4}$/i,'')].filter(id=>/^wxid_[a-z0-9_]+$/i.test(id));
  const matches=new Set(candidates.filter(id=>contacts.has(id)));
  for(const file of selectedFiles){
   const info=await readMessageInfo(file);checked.set(file,info);
   for(const id of info.senders.values())if(candidates.includes(id))matches.add(id);
  }
  if(matches.size!==1)throw Error('无法确认本人 wxid。请在高级选项中填写本人 wxid 后重试。');
  resolvedSelf=[...matches][0];
 }
 onProgress({stage:"正在写入联系人"});
 const allContacts=reuseContacts?[]:[...contacts.values()];
 for(let start=0;start<allContacts.length;start+=1000){
  store.importData({version:1,account,contacts:allContacts.slice(start,start+1000),messages:[]});
 }
 store.db.exec('CREATE TABLE IF NOT EXISTS wechat_sources(account TEXT,message_id TEXT,db_relative TEXT,table_name TEXT,source_local_id TEXT,PRIMARY KEY(account,message_id))');
 const put=store.db.prepare('INSERT OR IGNORE INTO wechat_sources VALUES(?,?,?,?,?)');
 if(control){
  store.db.exec('CREATE TABLE IF NOT EXISTS wechat_sync_window(account TEXT PRIMARY KEY, cutoff INTEGER NOT NULL)');
  if(!incremental)store.db.prepare('INSERT OR IGNORE INTO wechat_sync_window VALUES(?,?)').run(account.id,Math.floor(Date.now()/1000)-30*86400);
  control.cutoff=store.db.prepare('SELECT cutoff FROM wechat_sync_window WHERE account=?').get(account.id)?.cutoff;
  const legacyRanges=new Map();
  const legacy=store.db.prepare(`SELECT count(*) AS n, CAST(min(CAST(source_local_id AS INTEGER)) AS TEXT) AS low,
   CAST(max(CAST(source_local_id AS INTEGER)) AS TEXT) AS high FROM wechat_sources
   WHERE account=? AND message_id>=? AND message_id<? AND message_id=?||source_local_id
   AND source_local_id=CAST(CAST(source_local_id AS INTEGER) AS TEXT)
   AND EXISTS(SELECT 1 FROM messages m WHERE m.account=wechat_sources.account AND m.id=wechat_sources.message_id)`);
  const archived=store.db.prepare('SELECT 1 FROM wechat_sources s JOIN messages m ON m.account=s.account AND m.id=s.message_id WHERE s.account=? AND s.message_id=?');
  if(incremental)require('./wechat-incremental.cjs').openIncremental(store.db,account.id);
  let previewed=0;
  const shards=[];
  if(integrity&&!targets)for(const missing of integrity.tracked().filter(x=>x.startsWith('message/')&&!files.includes(x.slice(8)))){
   integrity.note(missing,'SOURCE_FILE_MISSING');failedSources.add(missing);retries.defer({source:missing,phase:'incremental'},{code:'SOURCE_CHANGED'});
  }
  for(const file of [...selectedFiles].reverse()){
   let info;
   try{info=checked.get(file)||await readMessageInfo(file)}
   catch(error){
    if(!incremental||control.state==='cancelled')throw error;
    const source='message/'+file;
    failedSources.add(source);retries.defer({source,phase:'incremental'},error);recordError(error,{source,phase:'incremental'},0,error.elapsedMs??0);
    checkCircuit();continue;
   }
   if(incremental){
    retries.resolve(info.relative,'incremental');
    const prefix=info.relative+':';
    const names=new Set(info.meta.map(row=>row.name));
    const known=local(()=>store.db.prepare('SELECT source,cursor FROM wechat_incremental_cursor WHERE account=? AND source>=? AND source<?').all(account.id,prefix,prefix+'￿'));
    for(const {source,cursor} of known)if((!selectedSources||selectedSources.has(info.relative)||selectedSources.has(source))&&!names.has(source.slice(prefix.length))){
     integrity.note(source,'SOURCE_TABLE_MISSING');failedSources.add(source);
     const context={source,phase:'incremental',checkpoint:cursor};
     const error={code:'SOURCE_CHANGED',diagnosticCode:'SOURCE_TABLE_MISSING'};
     retries.defer(context,error);recordError(error,context,0,0);
    }
   }
   shards.push(info);
   const sessionContacts=new Map();
   for(const {name} of info.meta){
    if(!/^(Msg|Chat)_[a-fA-F0-9]{32}$/.test(name)||selectedSources&&!selectedSources.has(info.relative+':'+name))continue;
    const hash=name.slice(name.indexOf('_')+1).toLowerCase();
    const chat=byHash.get(hash)||'unresolved:'+hash;
    sessionContacts.set(chat,contacts.get(chat)||{id:chat,name:'未解析会话 '+hash.slice(0,8)});
   }
   if(sessionContacts.size){
    store.importData({version:1,account,contacts:[...sessionContacts.values()],messages:[]});
    store.registerSessions(account.id,[...sessionContacts.keys()]);
    onProgress({stage:'会话列表已可浏览，正在加载近期消息',account:account.id,ready:true,scanned,added,skipped});
   }
   if(!incremental)await syncPhase('preview',[info]);
  }
  onProgress({stage:'近期消息可浏览',account:account.id,ready:true,scanned,added,skipped});
  if(incremental)await syncPhase('incremental',shards);
  else {await syncPhase('recent',shards);await syncPhase('history',shards);}
  databases=shards.length;
  if(!incremental&&!targets&&!retries.pending().some(item=>item.phase!=='incremental'))store.db.prepare('DELETE FROM wechat_sync_window WHERE account=?').run(account.id);
  async function syncPhase(phase,items){
   const stage={preview:'加载会话近期消息',recent:'补齐最近 30 天',history:'补齐更早的聊天记录',incremental:'检查新增聊天记录'}[phase];
   store.db.exec('CREATE TABLE IF NOT EXISTS wechat_sync_cursor(account TEXT, source TEXT, fingerprint TEXT, phase TEXT, cursor TEXT, done INTEGER, scanned INTEGER, skipped INTEGER, PRIMARY KEY(account,source,fingerprint,phase))');
   if(!store.db.prepare('PRAGMA table_info(wechat_sync_cursor)').all().some(c=>c.name==='scan_complete'))store.db.exec('ALTER TABLE wechat_sync_cursor ADD COLUMN scan_complete INTEGER NOT NULL DEFAULT 0');
   const get=store.db.prepare('SELECT * FROM wechat_sync_cursor WHERE account=? AND source=? AND fingerprint=? AND phase=?');
   const save=store.db.prepare('INSERT OR REPLACE INTO wechat_sync_cursor(account,source,fingerprint,phase,cursor,done,scanned,skipped,scan_complete) VALUES(?,?,?,?,?,?,?,?,?)');
   const daily=incremental?require('./wechat-incremental.cjs').openIncremental(store.db,account.id):null;
   const cutoff=control.cutoff;
   const phaseTables=(relative,meta)=>meta.filter(r=>/^(Msg|Chat)_[a-fA-F0-9]{32}$/.test(r.name)&&(!selectedPhases||selectedPhases.has(relative+':'+r.name+':'+phase)||phase==='preview'&&selectedSources.has(relative+':'+r.name)));
   const totalTables=phase==='preview'?undefined:items.reduce((n,{relative,meta})=>n+phaseTables(relative,meta).length,0);
   let doneTables=0;
   const phaseProgress=()=>onProgress({stage,phase,totalTables,doneTables,account:account.id,ready:true,scanned,checkpointScanned,savedBefore,saved:savedBefore===undefined?undefined:savedBefore+added,added,skipped,deduplicated,failedTables:failedSources.size});
   if(totalTables!==undefined)phaseProgress();
   for(const {relative,meta,senders} of items){
    for(const {name:table} of phaseTables(relative,meta)){
     await gate();
     checkCircuit();
     const source=relative+':'+table,fingerprint=snapshots.get(relative).fingerprint;
     const previous=daily?daily.get(source):get.get(account.id,source,fingerprint,phase);
     scanned+=previous?.scanned??0;checkpointScanned+=previous?.scanned??0;skipped+=previous?.skipped??0;
     if(!daily&&previous?.done&&!gaps.list(source,phase).length){retries.resolve(source,phase);doneTables++;continue;}
     let cursor=previous?.cursor?JSON.parse(previous.cursor):null;
     let phaseScanned=previous?.scanned??0,phaseSkipped=previous?.skipped??0;
     const preview=get.get(account.id,source,fingerprint,'preview');
     if(!daily&&phase!=='preview'&&!preview?.done&&!preview?.scan_complete)continue;
     if(!daily&&phase!=='preview'&&!preview.cursor){retries.resolve(source,phase);doneTables++;continue;}
     if(!daily&&!cursor&&phase!=='preview')cursor=JSON.parse(preview.cursor);
     const diagnosticContext={source,phase,checkpoint:previous?.cursor??null,isolateRow:true};
     const pendingRowId=targets?.find(item=>item.source===source&&item.phase===phase)?.row_id;
     const matchingTrace=daily&&trace?.chatHash===table.slice(table.indexOf('_')+1).toLowerCase()?{id:trace.id,t3:Date.now()}:null;
     if(matchingTrace)onProgress({tracePoint:{...matchingTrace}});
     let traceCommitted=false;
     try{
     const hash=table.slice(table.indexOf('_')+1).toLowerCase(),chat=byHash.get(hash)||'unresolved:'+hash;
     const contact=contacts.get(chat)||{id:chat,name:'未解析会话 '+hash.slice(0,8)};
     const context={relative,table,chat,self:resolvedSelf,senders};
     const schema=await query(relative,`PRAGMA table_info(${ident(table)})`);
     const columns=new Set(schema.map(column=>column.name));
     const pk=schema.filter(column=>Number(column.pk)>0);
     const stableLocalId=pk.length===1&&pk[0].name==='local_id'&&pk[0].type.toUpperCase()==='INTEGER';
     const timeColumn=columns.has('create_time')?'create_time':columns.has('msgCreateTime')?'msgCreateTime':null;
     if(!timeColumn)throw Object.assign(Error('消息表缺少时间列。'),{code:'SOURCE_SCHEMA',queryFailure:true});
     if(!daily&&!targets&&columns.has('local_id')&&!legacyRanges.has(source)){
      const prefix=source+':';
      const range=legacy.get(account.id,prefix,prefix+'￿',prefix);
      let verified=null;
      if(range.n&&BigInt(range.high)-BigInt(range.low)+1n===BigInt(range.n)){
       const [proof]=await query(relative,`SELECT count(*) AS n FROM ${ident(table)} WHERE rowid BETWEEN ${range.low} AND ${range.high} AND local_id=rowid`);
       if(BigInt(proof.n)===BigInt(range.n))verified=range;
      }
      legacyRanges.set(source,verified);
     }
     const timeSchema=schema.find(c=>c.name===timeColumn);
     const integerTime=timeSchema?.type.toUpperCase()==='INTEGER'&&Number(timeSchema.notnull)===1;
     const time=integerTime?ident(timeColumn):`coalesce(CAST(${ident(timeColumn)} AS INTEGER),-1)`;
     const fields=['create_time','msgCreateTime','local_id','mesLocalID','message_content','msgContent','content','compress_content','compressed_content','sender_username','sender','real_sender_id','is_send','isSend','local_type','message_type','msgType'];
     const payloads=fields.slice(4,9).filter(field=>columns.has(field));
     const project=(mode,audit=false)=>{
      const bound=mode==='metadata'?0:4194304;
      const oversize=payloads.length?payloads.map(field=>`length(CAST(${ident(field)} AS BLOB))>${bound}`).join(' OR '):'0';
      const selected=fields.filter(field=>columns.has(field)).map(field=>{
       const column=ident(field);
       return payloads.includes(field)?`CASE WHEN length(CAST(${column} AS BLOB))>${bound} THEN NULL ELSE ${audit?`CAST(${column} AS BLOB)`:column} END AS ${column}`:column;
      });
      return `rowid AS __rowid,${time} AS __time,CASE WHEN ${oversize} THEN 1 ELSE 0 END AS __oversize,${selected.join(',')}`;
     };
     // Oversized fields use bounded BLOB slices; UTF-8 is decoded only after byte-perfect reconstruction.
     const hydrate=async row=>{
      let assemblyBytes=0;
      for(const field of payloads){
       const [meta]=await query(relative,`SELECT length(CAST(${ident(field)} AS BLOB)) AS n FROM ${ident(table)} WHERE rowid=${row.__rowid}`);
       if(meta?.n==null){row[field]=null;continue;}
       const n=Number(meta.n);assemblyBytes+=n;
       if(!Number.isSafeInteger(n)||n<0||assemblyBytes>64*1024*1024)throw Object.assign(Error('正文超过有界重组上限。'),{code:'ROW_ASSEMBLY_LIMIT'});
       const chunks=[];let received=0;
       for(let offset=0;offset<n;offset+=262144){
        const [part]=await query(relative,`SELECT hex(substr(CAST(${ident(field)} AS BLOB),${offset+1},262144)) AS chunk FROM ${ident(table)} WHERE rowid=${row.__rowid}`);
        if(typeof part?.chunk!=='string'||!/^(?:[0-9a-f]{2})*$/i.test(part.chunk))throw Error('分段响应无效');
        const b=Buffer.from(part.chunk,'hex');if(b.length!==Math.min(262144,n-offset))throw Error('分段长度不匹配');chunks.push(b);received+=b.length;
       }
       if(received!==n)throw Error('正文重组不完整');
       row[field]=Buffer.concat(chunks,n);
      }
      row.__oversize='0';return row;
     };
     const parseRow=async row=>{
      try{if(row.__oversize==='1')await hydrate(row);row.message=normalize(row,context);}
      catch(error){if(control?.state==='cancelled'||error.message?.includes('同步已取消'))throw error;row.__gap=error.code||'ROW_CONTENT';}
      return row;
     };
     // Daily append cursors survive new snapshots only after bounded, byte-exact anchor checks.
     const proof=rowid=>require('./wechat-incremental.cjs').rowProof(query,relative,table,rowid,schema);
     let firstProof,firstRow,reconciliation;
     if(daily)await timed('anchors',async()=>{
      const [first]=await query(relative,`SELECT rowid AS id FROM ${ident(table)} ORDER BY rowid LIMIT 1`);
      firstRow=first?.id??null;firstProof=firstRow?await proof(firstRow):null;
      if(previous){
       if(cursor){
        const boundary=await proof(cursor[1]);
        const diagnosticCode=previous.first_row!==firstRow?'ANCHOR_FIRST_ROW_CHANGED':
         previous.first_proof!==firstProof?'ANCHOR_FIRST_PROOF_CHANGED':
         previous.anchor!==boundary?(boundary?'ANCHOR_BOUNDARY_CHANGED':'ANCHOR_BOUNDARY_MISSING'):null;
        if(diagnosticCode==='ANCHOR_BOUNDARY_CHANGED'&&stableLocalId&&(forceCheck||incrementalSourceId)&&
           integrity.known(relative,snapshots.get(relative).identities[relative])){
         const prefix=source+':',alias='rowid:'+prefix;
         const prior=store.db.prepare(`SELECT m.chat,m.ts,m.text,m.sender,m.kind,m.outgoing
          FROM wechat_sources s JOIN messages m ON m.account=s.account AND m.id=s.message_id
          WHERE s.account=? AND s.message_id=? AND s.db_relative=? AND s.table_name=? AND s.source_local_id=?`);
         const count=store.db.prepare(`SELECT
          (SELECT count(*) FROM wechat_sources WHERE account=? AND message_id>=? AND message_id<? AND CAST(source_local_id AS INTEGER)<=?) +
          (SELECT count(*) FROM wechat_sources WHERE account=? AND message_id>=? AND message_id<? AND CAST(source_local_id AS INTEGER)<=?) AS n`);
         reconciliation=await require('./wechat-incremental.cjs').verifyCanonicalPrefix({
          high:cursor[1],
          countPrior:high=>local(()=>count.get(account.id,prefix,prefix+'￿',high,account.id,alias,alias+'￿',high).n),
          readPrior:id=>local(()=>prior.get(account.id,prefix+id,relative,table,id)),
          loadPage:async(after,limit)=>{
           const select=`FROM ${ident(table)} WHERE rowid<=${BigInt(cursor[1])}${after===null?'':' AND rowid>'+after} ORDER BY rowid`;
           const page=await adaptivePage(async(size,mode)=>{
            if(mode==='identity'||mode==='gap'){
             const rows=await query(relative,`SELECT rowid AS __rowid,local_id ${select} LIMIT 1`);
             return {rows,cursorRows:rows};
            }
            const rows=await query(relative,`SELECT ${project(mode==='single'?'metadata':'normal',true)} ${select} LIMIT ${size}`);
            for(const row of rows){if(mode==='single')row.__oversize='1';await parseRow(row);if(row.message)row.message.sender=row.message.sender.slice(0,1000);}
            return {rows};
           },limit,{source,phase:'reconciliation',isolateRow:true});
           return page.rows;
          },
         });
        }
        if(diagnosticCode&&!reconciliation){
         integrity.note(source,'ANCHOR_CHANGED');
         throw Object.assign(Error('源分表身份变化，已保留增量断点；需要单独核对数据源。'),{code:'SOURCE_CHANGED',diagnosticCode,queryFailure:true});
        }
       }
      }else if(stableLocalId){
       // Upgrade seed: prove the last archived source row, never assume max timestamp means complete history.
       const prefix=source+':';
       const saved=local(()=>store.db.prepare(`SELECT CAST(max(CAST(source_local_id AS INTEGER)) AS TEXT) AS n FROM wechat_sources WHERE account=? AND message_id>=? AND message_id<? AND message_id=?||source_local_id`).get(account.id,prefix,prefix+'￿',prefix));
       if(saved.n!=null){
        const [row]=await query(relative,`SELECT ${project('normal')} FROM ${ident(table)} WHERE rowid=${BigInt(saved.n)} LIMIT 1`);
        if(row){await parseRow(row);const old=store.db.prepare('SELECT * FROM messages WHERE account=? AND id=?').get(account.id,source+':'+row.local_id);
         if(!row.message||!old||old.text!==row.message.text||old.ts!==row.message.timestamp||old.sender!==row.message.sender||old.kind!==row.message.kind||!!old.outgoing!==row.message.outgoing)
          throw Object.assign(Error('无法证明已有归档与源分表的增量边界，保留历史数据等待核对。'),{code:'SOURCE_CHANGED',queryFailure:true});
         cursor=['0',String(row.__rowid)];
        }else throw Object.assign(Error('源分表已缺少原有边界行，需核对数据源。'),{code:'SOURCE_CHANGED',queryFailure:true});
       }
      }
     });
     if(daily&&cursor)await timed('audit',async()=>{
      if(!stableLocalId){if(fullAudit)integrity.note(source,'UNSUPPORTED_ROWID_MAPPING');return;}
      const high=BigInt(cursor[1]),low=fullAudit?-9223372036854775808n:(high-127n < -9223372036854775808n?-9223372036854775808n:high-127n),prefix=source+':';
      const readArchived=store.db.prepare('SELECT ts,text,sender,kind,outgoing FROM messages WHERE account=? AND id=?');
      const lookup=id=>local(()=>readArchived.get(account.id,prefix+id));
      let matched=0,changed=0,unmapped=0,opaque=0,after;
      for(;;){
       const select=`FROM ${ident(table)} WHERE rowid BETWEEN ${low} AND ${high}${after===undefined?'':' AND rowid>'+after} ORDER BY rowid`;
       const result=await adaptivePage(async(limit,mode)=>{
        if(mode==='identity'||mode==='gap'){
         const cursorRows=await query(relative,`SELECT rowid AS __rowid ${select} LIMIT 1`);
         return {cursorRows,rows:cursorRows};
        }
        const selection=mode==='single'?project('metadata',true):project('normal',true);
        const rows=await query(relative,`SELECT ${selection} ${select} LIMIT ${limit}`);
        for(const row of rows){if(mode==='single')row.__oversize='1';await parseRow(row);}
        return {rows};
       },128,{source,phase:'integrity',isolateRow:true}).catch(error=>{integrity.note(source,'SOURCE_AUDIT_INCOMPLETE');throw error});
       for(const row of result.rows){
        const prior=lookup(row.__rowid);
        if(!prior){unmapped++;continue;}
        matched++;
        const m=row.message;
        if(!m){opaque++;continue;}
        if(prior.text!==m.text||prior.ts!==m.timestamp||prior.sender!==m.sender||prior.kind!==m.kind||!!prior.outgoing!==m.outgoing)changed++;
       }
       if(result.rows.length<result.limit)break;
       after=BigInt(result.rows.at(-1).__rowid);
      }
      let expected=0;
      if(fullAudit)expected=local(()=>store.db.prepare(`SELECT count(*) n FROM wechat_sources s JOIN messages m ON m.account=s.account AND m.id=s.message_id WHERE s.account=? AND s.message_id>=? AND s.message_id<? AND s.message_id=?||s.source_local_id AND CAST(s.source_local_id AS INTEGER) BETWEEN ? AND ?`).get(account.id,prefix,prefix+'￿',prefix,low,high).n);
      else for(let id=low;id<=high;id++)if(lookup(id.toString()))expected++;
      for(const [kind,n] of [['SOURCE_ROW_CHANGED',changed],['SOURCE_ROW_MISSING',Math.max(0,expected-matched)],['SOURCE_ROW_BELOW_WATERMARK',unmapped],['SOURCE_ROW_UNREADABLE',opaque]])if(n)integrity.note(source,kind,n);
     });
     // Retry only outstanding row IDs, without moving the successful scan cursor backwards.
     for(const gap of gaps.list(source,phase)){
      if(!/^-?\d+$/.test(gap.row_id))throw Error('缺口行号无效');
      let row;
      try{
       try{[row]=await query(relative,`SELECT ${project('normal')} FROM ${ident(table)} WHERE rowid=${gap.row_id} LIMIT 1`);}
       catch(error){
        if(!['ROW_BYTES','PAGE_BYTES'].includes(error.code))throw error;
        // A persisted gap must use the same bounded recovery path as a first encounter.
        [row]=await query(relative,`SELECT ${project('metadata')} FROM ${ident(table)} WHERE rowid=${gap.row_id} LIMIT 1`);
        if(row)row.__oversize='1';
       }
      }
      catch(error){
       if(!error.queryFailure)throw error;
       recordError(error,diagnosticContext,1,error.elapsedMs??0);checkCircuit();continue;
      }
      if(!row||gapIdentity(row)!==gap.identity_key){
       store.db.exec('BEGIN IMMEDIATE');try{gaps.unavailable(gap,fingerprint);store.db.exec('COMMIT')}catch(e){store.db.exec('ROLLBACK');throw e;}continue;
      } // Changed snapshot: retain original evidence.
      await parseRow(row);
      if(row.__gap){
       store.db.exec('BEGIN IMMEDIATE');try{
        gaps.record(source,phase,gap.fingerprint,row,row.__gap);
        recordError({code:row.__gap,rowGap:true,rows:1,bytes:batch?.responseBytes??0},diagnosticContext,1,0);
        store.db.exec('COMMIT');
       }catch(e){store.db.exec('ROLLBACK');throw e;}continue;
      }
      const local=String(row.local_id??row.mesLocalID??row.__rowid);
      row.message.sender=row.message.sender.slice(0,1000);
      if(row.message.id.length>1000)row.message.id=`rowid:${source}:${row.__rowid}`;
      // Duplicate local IDs retain the same stable rowid rule as normal batches.
      if(Object.hasOwn(row,'local_id')&&local!==String(row.__rowid)&&/^-?\d+$/.test(local)){
       const first=await query(relative,`SELECT rowid AS id FROM ${ident(table)} WHERE local_id=${local} ORDER BY rowid LIMIT 1`);
       if(first[0]?.id!==row.__rowid)row.message.id=`rowid:${source}:${row.__rowid}`;
      }
      const result=store.importData({version:1,account,contacts:[contact],messages:[row.message]},{maxMessageLength:64*1024*1024,onCommit:()=>{
       put.run(account.id,row.message.id,relative,table,local);gaps.resolve(source,phase,row);
      }});added+=result.added;
     }
     if(!daily&&previous?.scan_complete){
      const outstanding=gaps.list(source,phase);
      store.db.exec('BEGIN IMMEDIATE');try{
       save.run(account.id,source,fingerprint,phase,previous.cursor,Number(!outstanding.length),phaseScanned,phaseSkipped,1);
       if(outstanding.length)retries.defer(diagnosticContext,{rowId:outstanding[0].row_id,code:'ROW_GAPS'});else retries.resolve(source,phase);
       store.db.exec('COMMIT');
      }catch(e){store.db.exec('ROLLBACK');throw e;}
      if(!outstanding.length)doneTables++;continue;
     }
     let pageSize=phase==='preview'?30:500,successStreak=0;
     for(;;){
      if(phase==='preview')pageSize=Math.min(pageSize,30-phaseScanned);
      const where=[];
      if(cursor)where.push(daily?`rowid>${cursor[1]}`:`(${time},rowid)<(${cursor[0]},${cursor[1]})`);
      if(!daily&&phase!=='preview'){
       where.push(time+(phase==='recent'?'>=':'<')+cutoff);
       const range=legacyRanges.get(source);
       if(range)where.push(`rowid NOT BETWEEN ${range.low} AND ${range.high}`);
      }
      const filter=where.length?'WHERE '+where.join(' AND '):'';
      const order=daily?'ORDER BY rowid ASC':'ORDER BY __time DESC,rowid DESC';
      const identity=`rowid AS __rowid,${time} AS __time${columns.has('local_id')?',local_id':''}`;
      const select=`FROM ${ident(table)} ${filter} ${order}`;
      const read=async(limit,mode)=>{
       if(mode==='identity'||mode==='gap'){const cursorRows=await query(relative,`SELECT ${identity} ${select} LIMIT 1`);return {cursorRows,rows:mode==='gap'?cursorRows.map(row=>({...row,__gap:'ROW_READ_FAILED'})):[],already:0};}
       let rows,cursorRows,already=0;
       if(phase!=='preview'&&stableLocalId){
        cursorRows=await query(relative,`SELECT ${identity} ${select} LIMIT ${limit}`);
        const missing=cursorRows.filter(row=>row.__rowid===pendingRowId||row.local_id!==row.__rowid||!archived.get(account.id,source+':'+row.local_id));
        const ids=missing.map(row=>row.__rowid);
        if(!ids.every(id=>/^-?\d+$/.test(id)))throw Error('消息行号无效。');
        rows=ids.length?await query(relative,`SELECT ${mode==='single'?project('metadata'):project(mode)} FROM ${ident(table)} WHERE rowid IN (${ids.join(',')}) ${order} LIMIT ${limit}`):[];
        if(rows.length!==ids.length)throw Object.assign(Error('消息副本行数不一致。'),{code:'SOURCE_ROW_COUNT',queryFailure:true});
        already=cursorRows.length-rows.length;
       }else{
        rows=await query(relative,`SELECT ${mode==='single'?project('metadata'):project(mode)} ${select} LIMIT ${limit}`);
        cursorRows=rows;
       }
       for(const row of rows){
        if(mode==='single')row.__oversize='1';
        await parseRow(row);
       }
       return {rows,cursorRows,already};
      };
      const {rows,cursorRows,already,limit}=await adaptivePage(read,pageSize,diagnosticContext);
      const batchTrace=matchingTrace&&!traceCommitted&&rows.some(row=>row.message)?{...matchingTrace,t1:Date.now()}:undefined;
      if(batchTrace)onProgress({tracePoint:batchTrace});
      const grown=growBatch({size:pageSize,streak:successStreak},limit,phase==='preview'?30:500);pageSize=grown.size;successStreak=grown.streak;
      const messages=[],sources=[];
      for(const row of rows){
       if(row.__gap)continue;
       const message=row.message;
       // Keep legacy IDs for the first source row and use rowid for duplicates.
       const local=String(row.local_id??row.mesLocalID??row.__rowid);
       if(Object.hasOwn(row,'local_id')&&local!==String(row.__rowid)&&/^-?\d+$/.test(local)){
        const first=await query(relative,`SELECT rowid AS id FROM ${ident(table)} WHERE local_id=${local} ORDER BY rowid LIMIT 1`);
        if(first[0]?.id!==row.__rowid)message.id=`rowid:${source}:${row.__rowid}`;
       }
       if(message.id.length>1000)message.id=`rowid:${source}:${row.__rowid}`;
       message.sender=message.sender.slice(0,1000);
       messages.push(message);sources.push([message.id,local]);
      }
      if(cursorRows.length){
       cursor=[String(cursorRows.at(-1).__time),String(cursorRows.at(-1).__rowid)];
       if(!cursor.every(value=>/^-?\d+$/.test(value)))throw Error('消息游标无效。');
      }
      phaseScanned+=cursorRows.length;
      const scanComplete=(phase==='preview'&&phaseScanned>=30)||cursorRows.length<limit;
      let done=false;
      const anchor=daily&&cursor?await timed('anchors',()=>proof(cursor[1])):null;
      const result=store.importData({version:1,account,contacts:[contact],messages},{maxMessageLength:64*1024*1024,trace:batchTrace,onCommit:()=>{
       for(const [id,local] of sources)put.run(account.id,id,relative,table,local);
       for(const row of rows){if(row.__gap){gaps.record(source,phase,fingerprint,row,row.__gap);recordError({code:row.__gap,rowGap:true,rows:1,bytes:batch?.responseBytes??0},diagnosticContext,limit,0);}else gaps.resolve(source,phase,row);}
       const outstanding=gaps.list(source,phase);
       done=scanComplete&&!outstanding.length;
       if(reconciliation)integrity.reconcile(source,reconciliation.matched);
       if(daily)daily.save(source,{fingerprint,cursor:cursor?JSON.stringify(cursor):null,firstRow,firstProof,anchor,scanned:phaseScanned,done});
       else save.run(account.id,source,fingerprint,phase,cursor?JSON.stringify(cursor):null,Number(done),phaseScanned,phaseSkipped,Number(scanComplete));
       if(outstanding.length)retries.defer({...diagnosticContext,checkpoint:cursor?JSON.stringify(cursor):null},{rowId:outstanding[0].row_id,code:'ROW_GAPS'});
       else if(done)retries.resolve(source,phase);
      }});
      reconciliation=null;
      if(batchTrace&&result.added)traceCommitted=true;
      diagnosticContext.checkpoint=cursor?JSON.stringify(cursor):null;
      scanned+=cursorRows.length;
      if(cursorRows.length)consecutiveFailures=0;
      deduplicated+=already+messages.length-result.added;
      added+=result.added;
      if(done)doneTables++;
      onProgress({stage,phase,totalTables,doneTables,completedSessions:phase==='preview'?++previewed:previewed,account:account.id,ready:phase!=='preview'||messages.length>0,scanned,checkpointScanned,savedBefore,saved:savedBefore===undefined?undefined:savedBefore+added,added,skipped,deduplicated,failedTables:failedSources.size,errors,batchSize:limit,queryCount,maxResponseBytes,queryMs});
      if(scanComplete)break;
     }
     }catch(error){
      if(!error.queryFailure)throw error;
      if(matchingTrace)onProgress({tracePoint:{id:matchingTrace.id,failure:error.diagnosticCode||error.code}});
      failedSources.add(source);
      retries.defer(diagnosticContext,error);
      if(!error.recorded)recordError(error,diagnosticContext,0,error.elapsedMs??0);
      checkCircuit();
      onProgress({stage:'已保留失败分表断点，继续其他分表',account:account.id,ready:true,scanned,checkpointScanned,added,skipped,deduplicated,errors,failedTables:failedSources.size});
     }
    }
   }
   if(phase==='incremental')completedIncremental=doneTables;
   if(totalTables!==undefined)phaseProgress();
  }
 }else{
 let lastReport=0;
 for(const file of files){
  const {relative,meta,senders}=checked.get(file)||await readMessageInfo(file);
  databases++;
  const report=()=>onProgress({stage:"正在导入聊天记录",file,current:databases,total:files.length,scanned,added,skipped});
  report();
  for(const {name:table} of meta.filter(r=>/^(Msg|Chat)_[a-fA-F0-9]{32}$/.test(r.name))){
   const hash=table.slice(table.indexOf('_')+1).toLowerCase();let chat=byHash.get(hash);
   if(!chat){chat='unresolved:'+hash;contacts.set(chat,{id:chat,name:'未解析会话 '+hash.slice(0,8)});warnings.push('有会话无法与通讯录关联，保留稳定散列身份。');}
   const ids=new Set();
   const context={relative,table,chat,self:resolvedSelf,senders};
   let messages=[],sources=[];
   const flush=()=>{
    if(!messages.length)return;
    const result=store.importData({version:1,account,contacts:[contacts.get(chat)],messages},{maxMessageLength:8*1024*1024});
    added+=result.added;
    store.db.exec('BEGIN IMMEDIATE');
    try{
     for(const [id,local] of sources)put.run(account.id,id,relative,table,local);
     store.db.exec('COMMIT');
    }catch(e){store.db.exec('ROLLBACK');throw e;}
    messages=[];sources=[];
   };
   for await(const row of scanRows(relative,table)){
    scanned++;
    if(scanned%250===0&&Date.now()-lastReport>=500){lastReport=Date.now();report();}
    let message;
    try{message=normalize(row,context);}
    catch{skipped++;continue;}
    if(ids.has(message.id)||message.id.length>1000){
     message.id=`rowid:${relative}:${table}:${row.__rowid}`;
     recovered++;
    }
    ids.add(message.id);
    if(message.sender.length>1000)message.sender=message.sender.slice(0,1000);
    messages.push(message);
    sources.push([message.id,String(row.local_id??row.__rowid)]);
    if(messages.length===1000)flush();
   }
   flush();
  }
  report();
 }
 }
 if(oversized)warnings.push(`有 ${oversized} 条消息含超过 4 MiB 的正文或压缩内容，已保留消息标识和可读取字段。`);
 if(skipped)warnings.push(`有 ${skipped} 条消息因时间或内容无效而跳过。`);
 if(recovered)warnings.push(`有 ${recovered} 条消息使用数据库行号区分重复或超长标识。`);
 if(scanned&&skipped===scanned)throw Error('已读取消息表，但没有可导入的有效消息。');
 const pending=retries?.pending()||[];
 const integrityIssues=integrity?local(()=>integrity.count()):0;
 if(integrityIssues)warnings.push(`有 ${integrityIssues} 项来源差异待人工核对；没有覆盖或删除已归档消息。`);
 const incrementalPending=pending.filter(item=>item.phase==='incremental');
 if(eligible&&verifiedAt&&captureStamp().stamp===stamp){
  const unverifiedFiles=new Set(incrementalPending.map(item=>item.source.split(':')[0]));
  const verifiedFiles=Object.fromEntries(Object.entries(manifest.files).filter(([file])=>!unverifiedFiles.has(file)));
  // A partial run saves only clean files; its stamp never qualifies as a full receipt.
  local(()=>integrity.commit(grantId,incrementalPending.length?'':stamp,
   fullAudit||!receipt?Date.now()+week:receipt.audit_due,verifiedAt,verifiedFiles));
 }
 const incrementalFailure=pending.find(item=>item.phase==='incremental'&&['DB_FORMAT','SOURCE_CHANGED'].includes(item.kind))?.kind;
 if(pending.length)warnings.push(`有 ${pending.length} 个分表阶段保留待重试记录，尚未完成。`);
 return {account:account.id,selfId:resolvedSelf,name:account.name,verifiedAt,added,scanned:scanned-skipped,checkpointScanned,saved:savedBefore===undefined?undefined:savedBefore+added,integrityIssues,timings,incrementalFailure,completedIncremental,pendingShards:incrementalPending.slice(0,20).map(item=>({sourceId:sourceId(item.source),phase:item.phase,kind:item.kind})),historicalPending:pending.filter(item=>item.phase!=='incremental').length,failedTables:new Set(pending.filter(item=>!incremental||item.phase==='incremental').map(item=>item.source)).size,targeted:!!targets,incremental,databases,warnings:[...new Set(warnings)],mode:'validated-private-copy',walFiles:[...snapshots.values()].reduce((n,s)=>n+s.walFiles,0)};
 }catch(e){e.imported=added;e.scanned=scanned;throw e;}finally{onProgress({stage:"正在清理临时副本",scanned,added,skipped});try{if(batch)await batch.close();}finally{await Promise.all([...snapshots.values()].map(s=>s.cleanup()));}}
}
module.exports={readQuery,normalize,importWeChat,readMatchingIdentity};
