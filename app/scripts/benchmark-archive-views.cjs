const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{Worker}=require('node:worker_threads');
const {performance}=require('node:perf_hooks');
const {Store}=require('../electron/store.cjs');
(async()=>{
 const input=process.argv[2],temp=input?null:fs.mkdtempSync(path.join(os.tmpdir(),'mw-view-benchmark-')),file=input||path.join(temp,'workspace.sqlite');
 let worker;
 try{
  if(!input){
   const s=new Store(file);
   s.db.exec(`BEGIN; INSERT INTO accounts VALUES('synthetic','Synthetic');
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20000) INSERT INTO contacts SELECT 'synthetic','peer'||i,'Contact '||i FROM n;
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000000) INSERT INTO messages(account,id,chat,sender,ts,text,outgoing,kind)
    SELECT 'synthetic','m'||i,'peer'||(1+i%2000),'peer',1700000000+i*17,'synthetic message',i%2,CASE WHEN i%31=0 THEN 'image' WHEN i%53=0 THEN 'video' WHEN i%61=0 THEN 'voice' ELSE 'text' END FROM n;
    COMMIT;`);
   s.close();
  }
  const ro=new DatabaseSync(file,{readOnly:true}),account=ro.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get().id;ro.close();
  worker=new Worker(path.resolve(__dirname,'../electron/archive-view-worker.cjs'),{workerData:{database:file,derivedWrites:!input}});
  let id=0;
  const sample=async(method,args)=>{
   const start=performance.now(),value=await new Promise((resolve,reject)=>{
    worker.once('message',m=>m.error?reject(Error(m.error)):resolve(m.value));worker.once('error',reject);
    worker.postMessage({id:++id,method,args});
   });
   return {ms:Math.round((performance.now()-start)*10)/10,bytes:Buffer.byteLength(JSON.stringify(value)),value};
  };
  const cpu=process.cpuUsage(),diag=await sample('diagnostics',account);
  const directory=await sample('directory',{account,offset:10000}),media=await sample('mediaIndex',{account,limit:50}),next=media.value.next&&await sample('mediaIndex',{account,limit:50,before:media.value.next});
  const quick=process.argv.includes('--quick');
 const statsArgs=quick?{account,chat:media.value.items[0]?.chat,from:1700000000}: {account};
 const stats=await sample('stats',statsArgs),warm=await sample('stats',statsArgs);
  if(!input){
  assert.deepEqual(diag.value.current,{messages:1000000,contacts:20000,sessions:2000});
  assert.equal(stats.value.summary.total,1000000);assert.equal(stats.value.summary.sent,500000);
  assert.equal(directory.value.items.length,50);assert.equal(media.value.items.length,50);
  assert.ok(next);assert.equal(new Set([...media.value.items,...next.value.items].map(x=>x.rowid)).size,100);
  assert.deepEqual(warm.value,stats.value);
 }
 const metric=x=>x&&({ms:x.ms,bytes:x.bytes});
  console.log(JSON.stringify({fixture:input?(quick?'explicit-read-only-selected-chat':'explicit-read-only'):'synthetic-1m',diagnostics:{...metric(diag),counts:diag.value.current,completed:diag.value.completed,gaps:diag.value.gaps,pending:diag.value.pending},directory:{...metric(directory),rows:directory.value.items.length,withChats:directory.value.withChats},media:{...metric(media),rows:media.value.items.length,next:metric(next)},stats:{...metric(stats),summary:stats.value.summary,warm:metric(warm)},cpuMs:Object.values(process.cpuUsage(cpu)).reduce((a,b)=>a+b,0)/1000,peakRssKiB:process.resourceUsage().maxRSS},null,2));
 }finally{await worker?.terminate();if(temp)fs.rmSync(temp,{recursive:true,force:true})}
})().catch(e=>{console.error(e.message);process.exitCode=1});
