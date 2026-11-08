// Actual macOS file watcher, temporary SQLite WAL and private workspaces only.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),Module=require('node:module');
const {DatabaseSync}=require('node:sqlite'),{performance}=require('node:perf_hooks'),{execFileSync}=require('node:child_process');
const assert=require('node:assert/strict'),{Store}=require('../electron/store.cjs'),adapter=require('../electron/wechat-adapter.cjs'),current=require('../electron/auto-sync.cjs');
const prior='5c1de43cbaae2d371535d98cccf59a771a652e47';
function baseline(file,deps={}){
 const filename=path.resolve(__dirname,'../electron',file),m=new Module(filename,module);m.filename=filename;m.paths=module.paths;
 const original=m.require.bind(m);m.require=id=>Object.hasOwn(deps,id)?deps[id]:original(id);
 m._compile(execFileSync('git',['show',prior+':app/electron/'+file],{encoding:'utf8'}),filename);return m.exports;
}
async function measure(old,n=12){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mw-live-benchmark-')));
 const syncAPI=old?baseline('auto-sync.cjs'):current;
 const read=old?baseline('wechat-adapter.cjs',{'./auto-sync.cjs':syncAPI,'./wechat-integrity.cjs':baseline('wechat-integrity.cjs')}).importWeChat:adapter.importWeChat;
 let store,db,sync;
 try{
  const table='Msg_'+crypto.createHash('md5').update('peer').digest('hex');
  const directory=path.join(root,'db_storage');
  for(const rel of ['message','contact'])fs.mkdirSync(path.join(directory,rel),{recursive:true});
  const contacts=new DatabaseSync(path.join(directory,'contact/contact.db'));
  contacts.exec("CREATE TABLE contact(username TEXT,nick_name TEXT);INSERT INTO contact VALUES('peer','Synthetic peer');WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000) INSERT INTO contact SELECT 'synthetic-'||i,'Synthetic '||i FROM n");contacts.close();
  const file=path.join(directory,'message/message_0.db');
  db=new DatabaseSync(file);db.exec(`PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0; CREATE TABLE ${table}(local_id INTEGER PRIMARY KEY,create_time INTEGER,message_content TEXT,local_type INTEGER,is_send INTEGER)`);
  const other=new DatabaseSync(path.join(directory,'message/message_1.db'));
  other.exec(`CREATE TABLE ${table}(local_id INTEGER PRIMARY KEY,create_time INTEGER,message_content TEXT,local_type INTEGER,is_send INTEGER);
   WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50000)
   INSERT INTO ${table} SELECT i,1700000000, printf('%0256d',i),1,0 FROM n`);other.close();
  const insert=db.prepare(`INSERT INTO ${table} VALUES(?,1700000000,?,1,0)`);
  insert.run(1,'initial');
  const opts={root,allowDecrypted:true,profile:'4',selfId:'self',grantId:'synthetic-grant',incremental:true};
  let sample;
  store=new Store(path.join(root,'workspace.sqlite'),{messagesCommitted:()=>{if(sample&&!sample.t4)sample.t4=performance.now()}});
  const readSource=()=>read(store,opts,path.resolve(__dirname,'../native/.build/wechat-reader'),p=>{if(sample&&p.sourceVerified&&!sample.t3)sample.t3=performance.now()},{wait:async()=>{}});
  await readSource();
  const results=[];
  sync=new syncAPI.AutoSync({
   stamp:root=>syncAPI.sourceStamp(root),
   watch:(dir,handler)=>fs.watch(dir,(kind,name)=>{if(sample&&!sample.t1&&(String(name||'').includes('message_0.db')||dir.includes('message_0.db')))sample.t1=performance.now();handler(kind,name)}),
   run:async(_root,reason)=>{if(sample){sample.t2=performance.now();sample.reason=reason;}const r=await readSource();if(sample&&r.added){assert.equal(r.added,1);assert.ok(sample.t4);const finish=sample.finish;finish(r)}return r}
  });
  sync.configure(root,{enabled:true,interval:10});
  await sync.request(root,'startup');
  for(let i=0;i<n;i++){
   let finish;const done=new Promise(r=>{finish=r});sample={finish};
   insert.run(i+2,'synthetic live');
   sample.t0=performance.now();
   const result=await Promise.race([done,new Promise(resolve=>{setTimeout(()=>resolve(null),old?5000:13000).unref()})]);
   if(!result&&old)return {samples:i+1,missedWithinMs:5000,completedBeforeMiss:results.length};
   assert.ok(result,'Synthetic WAL refresh timeout');
   const {t0,t1,t2,t3,t4}=sample;
   assert.ok(t2>=t0&&t3>=t2&&t4>=t3,JSON.stringify({t0,t1,t2,t3,t4,reason:sample.reason}));
   results.push({watch:t1>=t0?t1-t0:null,reason:sample.reason,start:t2-t0,prepared:t3-t0,commit:t4-t0,snapshot:result.timings?.snapshotWal});
   sample=null;
   if(sync.busy(root))await sync.jobs.get(root).promise;
  }
  const nrows=store.db.prepare('SELECT count(*) n FROM messages').get().n;
  assert.equal(nrows,50001+n);
  const values={};
  for(const k of ['watch','start','prepared','commit','snapshot']){
   const sorted=results.map(r=>r[k]).filter(Number.isFinite).sort((a,b)=>a-b);
   if(sorted.length)values[k]=[.5,.95,.99].map(q=>+sorted[Math.ceil(sorted.length*q)-1].toFixed(3));
  }
  return {samples:n,archiveRows:nrows,probes:results.filter(r=>r.reason==='probe').length,walBytes:fs.statSync(file+'-wal').size,unchangedShardBytes:fs.statSync(path.join(directory,'message/message_1.db')).size,p50p95p99Ms:values};
 }finally{sync?.close();store?.close();db?.close();fs.rmSync(root,{recursive:true,force:true});}
}
(async()=>{console.log(JSON.stringify({prior,baseline:await measure(true,3),current:await measure(false)},null,2))})().catch(e=>{console.error(e.message);process.exitCode=1});
