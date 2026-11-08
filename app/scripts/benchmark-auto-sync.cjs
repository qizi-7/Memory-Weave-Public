// Same synthetic million-row source and archive for both implementations. Never opens a normal profile.
const {DatabaseSync}=require('node:sqlite'),{Store}=require('../electron/store.cjs'),{importWeChat}=require('../electron/wechat-adapter.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),{performance}=require('node:perf_hooks');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mw-increment-bench-'))),helper=path.resolve('native/.build/wechat-reader'),base=process.argv[2]||'48a8f27cf8b17ed28368ecd5bcad5ba3a6bf8404',n=Number(process.env.MW_BENCH_ROWS||1000000),gate={wait:async()=>{}};
(async()=>{
 try{
  for(const d of ['contact','message'])fs.mkdirSync(path.join(root,'db_storage',d),{recursive:true});
  const contacts=new DatabaseSync(path.join(root,'db_storage/contact/contact.db'));contacts.exec("CREATE TABLE contact(username TEXT);INSERT INTO contact VALUES('peer')");contacts.close();
  const file=path.join(root,'db_storage/message/message_0.db'),table='Msg_'+crypto.createHash('md5').update('peer').digest('hex');
  let db=new DatabaseSync(file);db.exec(`CREATE TABLE ${table}(local_id INTEGER PRIMARY KEY,create_time INTEGER NOT NULL,message_content TEXT,local_type INTEGER,is_send INTEGER);CREATE INDEX timeline ON ${table}(create_time);BEGIN`);const insert=db.prepare(`INSERT INTO ${table} VALUES(?,1700000000,?,1,0)`);for(let i=1;i<=n;i++)insert.run(i,'Synthetic '+i);db.exec('COMMIT');db.close();
  const account={id:'wechat:'+crypto.createHash('sha256').update(root).digest('hex'),name:'Synthetic'},args={root,selfId:'self',allowDecrypted:true,profile:'4'};
  const seed=path.join(root,'seed.sqlite'),store=new Store(seed);store.db.exec('CREATE TABLE wechat_sources(account TEXT,message_id TEXT,db_relative TEXT,table_name TEXT,source_local_id TEXT,PRIMARY KEY(account,message_id))');const map=store.db.prepare('INSERT INTO wechat_sources VALUES(?,?,?,?,?)');
  for(let start=1;start<=n;start+=1000){const messages=[];for(let i=start;i<Math.min(start+1000,n+1);i++)messages.push({id:'message/message_0.db:'+table+':'+i,chat:'peer',sender:'peer',timestamp:1700000000,text:'Synthetic '+i,kind:'text',outgoing:false});store.importData({version:1,account,contacts:[{id:'peer',name:'peer'}],messages},{onCommit:()=>{for(const m of messages)map.run(account.id,m.id,'message/message_0.db',table,m.id.split(':').at(-1))}})}
  if(process.env.MW_BENCH_EMPTY==='1'){
   const prior=process.argv[2]||'fc2b0f92ff8027a4d6d73086b480765dc4ded395';
   const load=(file,overrides={})=>{const m=new Module(path.resolve('electron/'+file));m.filename=path.resolve('electron/'+file);m.paths=module.paths;const req=m.require.bind(m);m.require=id=>Object.hasOwn(overrides,id)?overrides[id]:req(id);m._compile(execFileSync('git',['show',prior+':app/electron/'+file],{encoding:'utf8'}),m.filename);return m.exports;};
   const old=load('wechat-adapter.cjs',{'./wechat-snapshot.cjs':load('wechat-snapshot.cjs')}),grantId='synthetic-benchmark-grant';
   const contactDB=new DatabaseSync(path.join(root,'db_storage/contact/contact.db'));
   contactDB.exec("WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<20000) INSERT INTO contact SELECT 'synthetic-'||n FROM c");contactDB.close();
   const sourceDB=new DatabaseSync(file);sourceDB.exec("CREATE TABLE Name2Id(user_name TEXT);WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<20000) INSERT INTO Name2Id SELECT 'synthetic-'||n FROM c");sourceDB.close();
   await importWeChat(store,{...args,incremental:true,grantId},helper,()=>{},gate);store.close();
   const results={baseline:[],fullOpen:[],receipt:[]};
   for(let i=0;i<5;i++)for(const [label,read,opts] of [['baseline',old.importWeChat,{}],['fullOpen',importWeChat,{grantId,forceCheck:true}],['receipt',importWeChat,{grantId}]]){
    const archive=new Store(seed),cpu=process.cpuUsage(),start=performance.now();let peak=process.memoryUsage().rss;
    const timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss)},5);
    const r=await read(archive,{...args,...opts,incremental:true},helper,()=>{},gate);
    clearInterval(timer);const ms=performance.now()-start,usage=process.cpuUsage(cpu);assert.equal(r.added,0);assert.equal(!!r.unchanged,label==='receipt');
    results[label].push({ms,cpuMs:(usage.user+usage.system)/1000,rssMiB:Math.max(peak,process.memoryUsage().rss)/1048576,timings:r.timings});archive.close();
   }
   console.log(JSON.stringify({prior,rows:n,contactRows:20001,name2idRows:20000,restartsPerMode:5,results},null,2));return;
  }
  await importWeChat(store,{...args,incremental:true},helper,()=>{},gate);store.close();
  const oldModule=new Module(path.resolve('electron/baseline-adapter.cjs'));oldModule.filename=path.resolve('electron/baseline-adapter.cjs');oldModule.paths=module.paths;oldModule._compile(execFileSync('git',['show',base+':app/electron/wechat-adapter.cjs'],{encoding:'utf8'}),oldModule.filename);
  const results=[];let end=n;
  for(const [scenario,append] of [['empty',0],['append100',100],['append10000',10000],['newShard',100]]){
   if(scenario==='newShard'){const shard=new DatabaseSync(path.join(root,'db_storage/message/message_1.db'));shard.exec(`CREATE TABLE ${table}(local_id INTEGER PRIMARY KEY,create_time INTEGER NOT NULL,message_content TEXT,local_type INTEGER,is_send INTEGER);BEGIN`);const put=shard.prepare(`INSERT INTO ${table} VALUES(?,1700000000,'Synthetic shard',1,0)`);for(let i=1;i<=append;i++)put.run(i);shard.exec('COMMIT');shard.close()}
   else if(append){db=new DatabaseSync(file);db.exec('BEGIN');const put=db.prepare(`INSERT INTO ${table} VALUES(?,1700000000,?,1,0)`);for(let i=end+1;i<=end+append;i++)put.run(i,'Synthetic '+i);db.exec('COMMIT');db.close();end+=append}
   // Seed includes only the initial N. Each case has exactly the same work for old and new.
   const expected=append,expectedTotal=end+(scenario==='newShard'?100:0),pair=[];
   for(const [label,read,incremental] of [['0.3.7-history-entry',oldModule.exports.importWeChat,false],['0.3.8-incremental',importWeChat,true]]){
    const copy=path.join(root,label+'.sqlite');fs.copyFileSync(seed,copy);const archive=new Store(copy),cpu=process.cpuUsage(),start=performance.now();let peak=process.memoryUsage().rss,maxResponseBytes=0,queries=0;
    const sample=setInterval(()=>peak=Math.max(peak,process.memoryUsage().rss),10);
    const r=await read(archive,{...args,incremental},helper,p=>{maxResponseBytes=Math.max(maxResponseBytes,p.maxResponseBytes||0);queries=Math.max(queries,p.queryCount||0)},gate);
    clearInterval(sample);const ms=performance.now()-start,usage=process.cpuUsage(cpu);assert.equal(r.added,expected);assert.equal(archive.db.prepare('SELECT count(*) n FROM messages').get().n,expectedTotal);archive.close();for(const suffix of ['','-wal','-shm'])fs.rmSync(copy+suffix,{force:true});pair.push({label,elapsedMs:+ms.toFixed(2),added:r.added,scanned:r.scanned-(r.checkpointScanned||0),messagesPerSecond:+(r.added/(ms/1000)).toFixed(2),nodeCpuMs:+((usage.user+usage.system)/1000).toFixed(2),nodeRssPeakMiB:+(peak/1048576).toFixed(1),maxResponseBytes:maxResponseBytes||null,queries:queries||null});
   }
   const advance=new Store(seed);await importWeChat(advance,{...args,incremental:true},helper,()=>{},gate);advance.close();
   results.push({scenario,sourceRows:end+(scenario==='newShard'?100:0),workAdded:expected,pair});
  }
  console.log(JSON.stringify({sample:'synthetic-only',initialRows:n,baseline:base,results,limits:'RSS/CPU for Node process only; no renderer UI or native child CPU measurement'},null,2));
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e.message);process.exitCode=1});
