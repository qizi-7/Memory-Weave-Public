const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const intervals=new Set([1,2,3,5,10,15,30]);
// Encrypted authorization metadata is separate from database and media credential blobs.
function authorizations(file,secure){
 let rows={};
 const persist=()=>{if(!secure.available())throw Error('系统安全存储不可用。');const temp=file+'.'+randomUUID();fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});try{fs.writeFileSync(temp,secure.encrypt(JSON.stringify(rows)),{mode:0o600,flag:'wx'});fs.renameSync(temp,file)}finally{fs.rmSync(temp,{force:true})}};
 const load=()=>{if(fs.existsSync(file)){if(!secure.available())return 'storageUnavailable';try{const parsed=JSON.parse(secure.decrypt(fs.readFileSync(file)));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.entries(parsed).some(([root,row])=>!path.isAbsolute(root)||row?.root!==root||typeof row.binding!=='string'||typeof row.enabled!=='boolean'||!intervals.has(row.interval)||!row.options))throw Error('invalid authorization');rows=parsed;return null}catch{return 'reauthorize'}}return null};
 const issue=load();
 return {issue,list:()=>Object.values(rows),get:root=>rows[root],remove(root){delete rows[root];persist()},save(root,input){const stat=fs.statSync(root);const old=rows[root];rows[root]={root,grantId:randomUUID(),binding:`${stat.dev}:${stat.ino}`,options:{profile:input.profile||'auto',selfId:input.selfId||'',displayName:input.displayName||'',allowDecrypted:input.allowDecrypted===true},enabled:old?.enabled??true,interval:old?.interval??2,lastSuccess:old?.lastSuccess??null,lastAdded:old?.lastAdded??0,lastNormalCheck:old?.lastNormalCheck??null,lastCommit:old?.lastCommit??null};persist();return rows[root]},update(root,patch){if(!rows[root])throw Error('需要先授权保存数据库凭据。');if(patch.interval!==undefined&&!intervals.has(patch.interval))throw Error('同步间隔无效。');rows[root]={...rows[root],...patch};persist();return rows[root]},check(root){const row=rows[root];if(!row)return 'unconfigured';try{if(fs.realpathSync(root)!==root)return 'sourceChanged';const s=fs.statSync(root);return row.binding===`${s.dev}:${s.ino}`?'savedUnverified':'sourceChanged'}catch{return 'sourceChanged'}}};
}
function sourceManifest(root){
 const hash=createHash('sha256'),data=path.join(root,'db_storage'),files={};
 for(const relative of ['contact','message']){
  const dir=path.join(data,relative);
  if(fs.realpathSync(dir)!==dir)throw Object.assign(Error('微信数据目录已变化。'),{code:'SOURCE_CHANGED'});
  const d=fs.statSync(dir,{bigint:true}),identity=`${d.dev}:${d.ino}:${d.birthtimeNs}`;
  hash.update(identity);
  const names=fs.readdirSync(dir).filter(n=>relative==='contact'?/^contact\.db(?:-wal)?$/.test(n):/^message_\d+\.db(?:-wal)?$/.test(n)).sort();
  for(const name of names){
   const file=path.join(dir,name),st=fs.lstatSync(file,{bigint:true});
   if(!st.isFile())throw Object.assign(Error('微信数据库或日志不是普通文件。'),{code:'SOURCE_CHANGED'});
   const base=relative+'/'+name.replace(/-wal$/,'');
   const part=`${identity}:${relative}/${name}:${st.dev}:${st.ino}:${st.birthtimeNs}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
   const stamp=createHash('sha256').update(files[base]||'').update(part);
   if(!name.endsWith('-wal'))stamp.update(require('./wechat-integrity.cjs').fileIdentity(file));
   files[base]=stamp.digest('hex');
  }
 }
 return {stamp:hash.update(JSON.stringify(files)).digest('hex'),files};
}
const sourceStamp=root=>sourceManifest(root).stamp;
// All triggers merge into one pending request. Only a successfully committed run advances the stamp.
class AutoSync {
 constructor({run,status=()=>{},stamp=sourceStamp,watch=fs.watch,clock=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,debounce=650,retryDelay=30000,probeInterval=4000,cooldown=300000}){Object.assign(this,{run,status,stamp,watch,clock,setTimer,clearTimer,debounce,retryDelay,probeInterval,cooldown});this.jobs=new Map();this.closed=false;}
 configure(root,settings){
  let job=this.jobs.get(root);if(!job){job={root,busy:false,pending:false,watchers:[],fileWatchers:new Map(),failures:0};this.jobs.set(root,job)}
  if(job.settings?.grantId!==settings.grantId){job.blocked=false;job.failures=0;}
  Object.assign(job,{settings});this.clearTimer(job.timer);this.clearTimer(job.poll);this.clearTimer(job.probe);this.clearTimer(job.retry);this.clearTimer(job.partialRetry);job.timer=null;job.retry=null;job.partialRetry=null;
  for(const w of job.watchers)w.close();job.watchers=[];
  for(const w of job.fileWatchers.values())w.close();job.fileWatchers.clear();
  if(this.closed||!settings.enabled){job.timer=null;job.retry=null;job.pending=false;job.nextCheck=null;this.status(root,{nextCheck:null});return}
  const onChange=(_kind,name)=>{if(!name||/\.db(?:-wal)?$/.test(String(name)))this.request(root,'change').catch(()=>{})};
  const dirs=['contact','message'].map(part=>path.join(root,'db_storage',part));
  // On macOS, directory watches can miss in-place writes to an existing WAL.
  job.attachFiles=()=>{
   for(const dir of dirs)try{
    if(fs.realpathSync(dir)!==dir)continue;
    for(const name of fs.readdirSync(dir)){
     if(!/^(?:contact|message_\d+)\.db(?:-wal)?$/.test(name))continue;
     const file=path.join(dir,name);
     if(job.fileWatchers.has(file)||!fs.lstatSync(file).isFile())continue;
     const w=this.watch(file,(kind)=>{
      if(kind==='rename'){job.fileWatchers.delete(file);w.close();}
      onChange(kind,name);
     });
     job.fileWatchers.set(file,w);
     w.on('error',()=>{job.fileWatchers.delete(file);w.close();job.watcherFallback=true});
    }
   }catch{job.watcherFallback=true}
  };
  for(const dir of dirs)try{const w=this.watch(dir,(kind,name)=>{if(kind==='rename')job.attachFiles();onChange(kind,name)});w.on('error',()=>{w.close();job.watcherFallback=true});job.watchers.push(w)}catch{job.watcherFallback=true}
  job.attachFiles();
  this.poll(job);this.probe(job);
 }
 poll(job){if(this.closed||!job.settings.enabled)return;job.nextCheck=this.clock()+job.settings.interval*60000;this.status(job.root,{nextCheck:job.nextCheck,watcherFallback:!!job.watcherFallback});job.poll=this.setTimer(()=>{this.request(job.root,'poll').catch(()=>{});this.poll(job)},job.settings.interval*60000);job.poll?.unref?.();}
 probe(job){if(this.closed||!job.settings.enabled)return;job.probe=this.setTimer(()=>{if(!job.busy){job.attachFiles?.();this.request(job.root,'probe').catch(()=>{});}this.probe(job)},this.probeInterval);job.probe?.unref?.();}
 request(root,reason='manual'){
  const job=this.jobs.get(root);if(!job||this.closed)return Promise.resolve(false);
  if(reason!=='manual'&&!job.settings.enabled)return Promise.resolve(false);
  if((job.blocked&&reason!=='manual')||(job.retry&&reason==='probe'))return Promise.resolve(false);
  if(job.busy){job.pending=true;return job.promise}
  if(reason==='change'){if(job.timer)return Promise.resolve(false);job.timer=this.setTimer(()=>{job.timer=null;this.request(root,'event').catch(()=>{})},this.debounce);job.timer?.unref?.();return Promise.resolve(false)}
  this.clearTimer(job.timer);job.timer=null;
  job.busy=true;
  job.promise=(async()=>{
   let stamp;
   try{
    stamp=await this.stamp(root);if(reason!=='manual'&&(!job.failures&&stamp===job.lastStamp&&!['poll','startup','wake','partial-retry'].includes(reason)||job.failures>=3&&stamp===job.failedStamp&&this.clock()<job.retryAt))return false;
    if(reason==='manual'||reason!=='retry'&&stamp!==job.failedStamp||job.failures>=3&&this.clock()>=job.retryAt)job.failures=0;
    if(this.closed||reason!=='manual'&&!job.settings.enabled)return false;
    const detectedAt=stamp!==job.lastStamp?this.clock():undefined;
    this.status(root,{state:'checking',failure:null});
    const result=await this.run(root,reason,detectedAt);
    const now=this.clock();
    job.lastStamp=stamp;job.failures=0;job.blocked=false;
    const partial=!!result.failedTables;
    this.clearTimer(job.partialRetry);job.partialRetry=null;
    if(!partial||stamp!==job.partialStamp){job.partialStamp=stamp;job.partialAttempts=0;}
    // Retry transient partials a bounded number of times without holding change/probe processing.
    if(partial&&!['SOURCE_CHANGED','DB_FORMAT','ROW_GAPS'].includes(result.incrementalFailure||result.pendingShards?.[0]?.kind)
     &&job.partialAttempts<2&&job.settings.enabled&&!this.closed){
     job.partialAttempts++;
     job.partialRetry=this.setTimer(()=>{job.partialRetry=null;this.request(root,'partial-retry').catch(()=>{})},this.retryDelay*job.partialAttempts);
     job.partialRetry?.unref?.();
    }
    const failure=partial?(result.incrementalFailure==='SOURCE_CHANGED'?'SHARD_CHANGED':result.incrementalFailure||'TABLE_PENDING'):null;
    this.status(root,{state:partial?'partial':'verified',failure,failedTables:result.failedTables??0,
     integrityIssues:result.integrityIssues??0,lastAdded:result.added??0,
     ...(!partial||result.completedIncremental>0?{lastNormalCheck:now}:{}),
     ...(!partial?{lastSuccess:now}:{}),
     ...(result.added>0?{lastCommit:now}:{})});
    return result;
   }catch(error){
    job.failures++;job.failedStamp=stamp;if(job.failures>=3)job.retryAt=this.clock()+this.cooldown;
    const kind=error.code||'SYNC_FAILED';job.blocked=['SOURCE_CHANGED','DB_FORMAT','CREDENTIAL_MISSING','STORAGE_UNAVAILABLE'].includes(kind);
    this.status(root,{state:kind==='SOURCE_CHANGED'?'sourceChanged':kind==='DB_FORMAT'?'mismatch':kind==='CREDENTIAL_MISSING'?'reauthorize':kind==='STORAGE_UNAVAILABLE'?'storageUnavailable':'error',failure:kind});
    if(kind!=='SYNC_CANCELLED'&&!job.blocked&&job.failures<=2&&job.settings.enabled&&!this.closed){job.retry=this.setTimer(()=>{job.retry=null;this.request(root,'retry').catch(()=>{})},this.retryDelay*job.failures);job.retry?.unref?.()}
    throw error;
   }finally{job.busy=false;if(job.pending){job.pending=false;if(!job.failures&&job.settings.enabled&&!this.closed)this.request(root,'change').catch(()=>{})}}
  })();return job.promise;
 }
 wake(){for(const root of this.jobs.keys())this.request(root,'wake').catch(()=>{})}
 busy(root){return this.jobs.get(root)?.busy||false}
 close(){this.closed=true;for(const job of this.jobs.values()){for(const field of ['timer','poll','probe','retry','partialRetry'])this.clearTimer(job[field]);for(const w of job.watchers)w.close();for(const w of job.fileWatchers.values())w.close();job.fileWatchers.clear();job.pending=false}}
}
module.exports={authorizations,AutoSync,sourceStamp,sourceManifest};
