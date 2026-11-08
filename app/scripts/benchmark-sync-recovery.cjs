// Compare the real main adapter with the repair on one synthetic source, without private data.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),Module=require('node:module'),{execFileSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite'),{Store}=require('../electron/store.cjs'),{performance}=require('node:perf_hooks');
const adapter=path.resolve('electron/wechat-adapter.cjs'),old=new Module(adapter,module);old.filename=adapter;old.paths=Module._nodeModulePaths(path.dirname(adapter));
old._compile(execFileSync('git',['show',(process.argv[2]||'origin/main')+':app/electron/wechat-adapter.cjs'],{encoding:'utf8'}),adapter);
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mw-recovery-comparison-'));for(const name of ['contact','message'])fs.mkdirSync(path.join(root,'db_storage',name),{recursive:true});
 const contacts=new DatabaseSync(path.join(root,'db_storage/contact/contact.db'));contacts.exec("CREATE TABLE contact(username TEXT);INSERT INTO contact VALUES('peer')");contacts.close();
 const table='Msg_'+crypto.createHash('md5').update('peer').digest('hex'),file=path.join(root,'db_storage/message/message_0.db'),db=new DatabaseSync(file);
 db.exec(`CREATE TABLE ${table}(local_id INTEGER PRIMARY KEY,create_time INTEGER NOT NULL,message_content);CREATE INDEX timeline ON ${table}(create_time);
 WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1200) INSERT INTO ${table} SELECT i,1700000000,'synthetic' FROM n;
 UPDATE ${table} SET message_content=x'ff' WHERE local_id=700`);db.close();
 const results=[];
 try{
  for(const [label,implementation] of [['main-0.3.5',old.exports],['0.3.6',require('../electron/wechat-adapter.cjs')]]){
   const store=new Store(':memory:'),start=performance.now();try{
    const result=await implementation.importWeChat(store,{root,selfId:'self',allowDecrypted:true},path.resolve('native/.build/wechat-reader'),()=>{},{wait:async()=>{}});
    const saved=store.db.prepare('SELECT count(*) n FROM messages').get().n;
    const olderNeighbour=!!store.db.prepare("SELECT 1 FROM messages WHERE id LIKE '%:699'").get();
    const newerNeighbour=!!store.db.prepare("SELECT 1 FROM messages WHERE id LIKE '%:701'").get();
    results.push({label,sourceRows:1200,saved,olderNeighbour,newerNeighbour,pendingTables:result.failedTables,elapsedMs:Math.round(performance.now()-start)});
   }finally{store.close()}
  }console.log(JSON.stringify(results,null,2));
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})().catch(()=>{console.error('Synthetic recovery comparison failed');process.exitCode=1});
