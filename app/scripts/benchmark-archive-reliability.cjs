// Million-row, multiple-account synthetic regression; no discovery of user archives.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const {DatabaseSync}=require('node:sqlite'),{Worker}=require('node:worker_threads');
const {Store}=require('../electron/store.cjs'),{prepareProjection}=require('../electron/archive-projection.cjs');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mw-million-reliability-')),file=path.join(dir,'workspace.sqlite');let store,worker;
 try{
  store=new Store(file);const db=store.db;
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'archive_fact_%'").all())db.exec('DROP TRIGGER '+name);
  db.exec(`BEGIN;INSERT INTO accounts VALUES('a','Synthetic A'),('b','Synthetic B'),('c','Synthetic C');
   WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000000)
   INSERT INTO messages(account,id,chat,sender,ts,text,outgoing,kind)
   SELECT CASE i%3 WHEN 0 THEN 'a' WHEN 1 THEN 'b' ELSE 'c' END,'m'||i,'p'||(i%2000),'p',
    CASE WHEN i%211=0 THEN 1 ELSE 1700000000+i END,'synthetic',i%2,
    CASE i%4 WHEN 0 THEN 'text' WHEN 1 THEN 'image' WHEN 2 THEN 'video' ELSE 'voice' END FROM n;COMMIT;`);
  require('../electron/archive-projection.cjs').installProjection(db);
  const start=performance.now();await prepareProjection(db);const buildMs=performance.now()-start;
  const oracle=db.prepare('SELECT count(*) total,coalesce(sum(outgoing),0) sent FROM effective WHERE hidden=0').get();
  const before=db.prepare('SELECT count(*) n FROM messages').get().n;
  worker=new Worker(path.resolve(__dirname,'../electron/archive-view-worker.cjs'),{workerData:{database:file,derivedWrites:true}});
  let seq=0;const pending=new Map();
  worker.on('message',m=>{const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.value)}});
  worker.on('error',e=>{for(const p of pending.values())p.reject(e);pending.clear()});
  const request=(method,args)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});worker.postMessage({id,method,args})});
  const cpu=process.cpuUsage(),statsStart=performance.now(),stats=await request('stats',{}),statsMs=performance.now()-statsStart;
  assert.equal(stats.summary.total,oracle.total);assert.equal(stats.summary.sent,oracle.sent);
  const result={fixture:'synthetic-1m-3accounts-2000chats',buildMs,statsMs,media:[]};
  for(const filter of [{from:0,to:2},{account:'a',from:0,to:2},{account:'b',chat:'p3',from:0,to:2}]){
   const clauses=['hidden=0',"kind IN ('image','video','voice')",'ts>=?','ts<?'],params=[filter.from,filter.to];
   for(const field of ['account','chat'])if(filter[field]){clauses.push(field+'=?');params.push(filter[field])}
   const expected=db.prepare('SELECT rowid FROM effective WHERE '+clauses.join(' AND ')+' ORDER BY rowid DESC').all(...params).map(x=>x.rowid);
   const collected=[];let before,maxMs=0,maxBytes=0,pages=0,totalMs=0;
   do{const start=performance.now(),page=await request('mediaIndex',{...filter,before,limit:50}),ms=performance.now()-start;
    maxMs=Math.max(maxMs,ms);totalMs+=ms;maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(page)));pages++;
    assert.ok(ms<180000,'media IPC timeout');collected.push(...page.items.map(x=>x.rowid));before=page.next;
   }while(before!==null);
   assert.deepEqual(collected,expected);assert.equal(new Set(collected).size,collected.length);
   result.media.push({scope:filter.chat?'single-chat':filter.account?'single-account':'all-accounts',ancient:true,rows:expected.length,pages,maxMs,totalMs,maxBytes});
  }
  let beforeCursor,all=[];
  for(let i=0;i<100;i++){const page=await request('mediaIndex',{limit:50,before:beforeCursor});all.push(...page.items.map(x=>x.rowid));beforeCursor=page.next}
  const expected=db.prepare("SELECT rowid FROM effective WHERE hidden=0 AND kind IN ('image','video','voice') ORDER BY rowid DESC LIMIT 5000").all().map(x=>x.rowid);
  assert.deepEqual(all,expected);assert.equal(db.prepare('SELECT count(*) n FROM archive_facts WHERE kind<>\'text\'').get().n,750000);
  assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,before);
  const rowid=db.prepare("SELECT rowid FROM messages WHERE account='a' LIMIT 1").get().rowid;
  store.edit({account:'a',rowid,text:'local edit',note:'',ts:0,hidden:true});
  assert.equal((await request('stats',{})).summary.total,999999);store.undo({account:'a',rowid});
  assert.equal((await request('stats',{})).summary.total,1000000);
  result.largeMedia={available:750000,checkedConsecutiveRows:all.length,duplicates:0};
  result.cpuMs=Object.values(process.cpuUsage(cpu)).reduce((a,b)=>a+b)/1000;result.peakRssKiB=process.resourceUsage().maxRSS;
  result.sourceMessagesBefore=before;result.sourceMessagesAfter=db.prepare('SELECT count(*) n FROM messages').get().n;
  console.log(JSON.stringify(result,null,2));
 }finally{await worker?.terminate();store?.close();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e.message);process.exitCode=1});
