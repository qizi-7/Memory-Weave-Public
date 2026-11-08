const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {Store}=require('../electron/store.cjs'),{importWeChat}=require('../electron/wechat-adapter.cjs');
const {openBatchReader}=require('../electron/wechat-batch-reader.cjs'),{openGaps}=require('../electron/wechat-sync-gaps.cjs');
const helper=path.resolve('native/.build/wechat-reader');
function fixture(n=1200){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mw-036-'));
 for(const section of ['contact','message'])fs.mkdirSync(path.join(root,'db_storage',section),{recursive:true});
 const contacts=new DatabaseSync(path.join(root,'db_storage/contact/contact.db'));contacts.exec("CREATE TABLE contact(username TEXT);INSERT INTO contact VALUES('peer')");contacts.close();
 const file=path.join(root,'db_storage/message/message_0.db'),db=new DatabaseSync(file),table='Msg_'+crypto.createHash('md5').update('peer').digest('hex');
 db.exec(`CREATE TABLE ${table}(local_id INTEGER PRIMARY KEY,create_time INTEGER NOT NULL,message_content,local_type INTEGER,is_send INTEGER);CREATE INDEX timeline ON ${table}(create_time)`);
 const put=db.prepare(`INSERT INTO ${table} VALUES(?,1700000000,?,1,0)`);db.exec('BEGIN');for(let i=1;i<=n;i++)put.run(i,'synthetic\u2028line\u2029end');db.exec('COMMIT');
 return {root,file,db,table,args:{root,selfId:'self',allowDecrypted:true,profile:'4'}};
}
test('bad UTF-8 row does not block either neighbour; gaps, checkpoints and source mappings persist across restart',async()=>{
 const f=fixture();const workspace=path.join(f.root,'workspace.sqlite');let store=new Store(workspace);
 try{
  f.db.exec(`UPDATE ${f.table} SET message_content=CAST(x'ff' AS TEXT) WHERE local_id=700`);f.db.close();
  const before=crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex');
  const result=await importWeChat(store,f.args,helper,()=>{},{wait:async()=>{}});
  assert.equal(result.added,1199);assert.equal(result.failedTables,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM wechat_sources').get().n,1199);
  for(const local of [1,699,701,1200])assert.ok(store.db.prepare('SELECT 1 FROM messages WHERE id LIKE ?').get('%:'+local));
  assert.equal(store.db.prepare('SELECT row_id,kind FROM wechat_sync_gaps WHERE resolved_at IS NULL').get().row_id,'700');
  const checkpoint=store.db.prepare("SELECT * FROM wechat_sync_cursor WHERE phase='history'").get();assert.equal(checkpoint.done,0);assert.equal(checkpoint.scan_complete,1);
  store.close();store=new Store(workspace);
  const retry=await importWeChat(store,{...f.args,retryFailed:true},helper,()=>{},{wait:async()=>{}});
  assert.equal(retry.added,0);assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,1199);
  assert.equal(store.db.prepare("SELECT scanned FROM wechat_sync_cursor WHERE phase='history'").get().scanned,checkpoint.scanned);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),before);
  // A new snapshot with a replacement rowid must not accidentally resolve the original identity.
  const changed=new DatabaseSync(f.file);changed.exec(`UPDATE ${f.table} SET local_id=9000,message_content='different identity' WHERE local_id=700`);changed.close();
  await importWeChat(store,{...f.args,retryFailed:true},helper,()=>{},{wait:async()=>{}});
  assert.equal(store.db.prepare('SELECT count(*) n FROM wechat_sync_gaps WHERE resolved_at IS NULL').get().n,1);
  assert.equal(store.db.prepare("SELECT max(done) n FROM wechat_sync_cursor WHERE phase='history'").get().n,0);
 }finally{store.close();fs.rmSync(f.root,{recursive:true,force:true})}
});
test('single row exceeding 16 MiB serialized JSON reassembles exact body with bounded requests and full metadata',async()=>{
 const f=fixture(3),store=new Store(':memory:');
 try{
  // 3 MiB of control bytes expands to 18 MiB JSON, below the raw-field threshold.
  const body='\x01'.repeat(3*1024*1024)+'\u2028\u2029中文';
  f.db.prepare(`UPDATE ${f.table} SET message_content=?,local_type=49,is_send=1 WHERE local_id=2`).run(body);f.db.close();
  const reader=openBatchReader(helper,f.file,'','4');
  try{await assert.rejects(reader.query(`SELECT message_content FROM ${f.table} WHERE local_id=2`),e=>e.code==='ROW_BYTES'&&e.bytes<=16*1024*1024);}finally{await reader.close()}
  const result=await importWeChat(store,f.args,helper,()=>{},{wait:async()=>{}});
  assert.equal(result.added,3);assert.equal(result.failedTables,0);
  const saved=store.db.prepare("SELECT text,kind,outgoing FROM messages WHERE id LIKE '%:2'").get();assert.equal(saved.text,body);assert.equal(saved.kind,'link');assert.equal(saved.outgoing,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM wechat_sync_gaps WHERE resolved_at IS NULL').get().n,0);
 }finally{store.close();fs.rmSync(f.root,{recursive:true,force:true})}
});
test('raw body above 16 MiB is completely reconstructed, with metadata and no content truncation',async()=>{
 const f=fixture(1),store=new Store(':memory:');try{
  const body='x'.repeat(17*1024*1024)+'end';f.db.exec(`ALTER TABLE ${f.table} ADD COLUMN msgContent TEXT`);f.db.prepare(`UPDATE ${f.table} SET message_content=NULL,msgContent=?`).run(body);f.db.close();
  const result=await importWeChat(store,f.args,helper,()=>{},{wait:async()=>{}});assert.equal(result.added,1);assert.equal(result.failedTables,0);
  assert.equal(store.db.prepare('SELECT text FROM messages').get().text,body);
 }finally{store.close();fs.rmSync(f.root,{recursive:true,force:true})}
});
test('gap, message, source map and checkpoint changes roll back as one transaction',()=>{
 const store=new Store(':memory:');try{
  const gaps=openGaps(store.db,'a');store.db.exec('CREATE TABLE test_sources(id TEXT);CREATE TABLE test_cursor(id TEXT)');
  assert.throws(()=>store.importData({version:1,account:{id:'a',name:'a'},contacts:[{id:'p',name:'p'}],messages:[{id:'1',chat:'p',sender:'p',timestamp:1,text:'safe',kind:'text',outgoing:false}]},{onCommit:()=>{
   store.db.exec("INSERT INTO test_sources VALUES('1');INSERT INTO test_cursor VALUES('1')");gaps.record('s','history','fingerprint',{__rowid:'2',__time:'2'},'ROW_CONTENT');throw Error('simulated commit failure');
  }}));
  for(const table of ['messages','test_sources','test_cursor','wechat_sync_gaps'])assert.equal(store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
 }finally{store.close()}
});
test('persisted retry options retain target and authorization mode, never a media key or a database credential',()=>{
 const {retryContexts,sourceCredential}=require('../electron/wechat-retry-context.cjs');const root=fs.mkdtempSync(path.join(os.tmpdir(),'mw-retry-')),file=path.join(root,'config.local.json');
 try{
  let context=retryContexts(file);context.save({root:'/synthetic',key:'do-not-save',profile:'3',selfId:'self',displayName:'Test',allowDecrypted:true});context.target('/synthetic','123456789abc');
  context=retryContexts(file);assert.deepEqual(context.get('/synthetic'),{profile:'3',selfId:'self',displayName:'Test',allowDecrypted:true,retrySourceId:'123456789abc',retryFailed:true});
  assert.ok(!fs.readFileSync(file,'utf8').includes('do-not-save'));assert.equal(fs.statSync(file).mode&0o777,0o600);
  const vault={hasKey:(root,scope)=>scope==='media',loadKey:()=>{throw Error('media must not be read')}};
  assert.equal(sourceCredential('/synthetic',new Map(),vault),'');assert.equal(sourceCredential('/synthetic',new Map([['/synthetic','source-only']]),vault),'source-only');
  context.finish('/synthetic');assert.equal(context.get('/synthetic').retrySourceId,undefined);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('INTEGER NOT NULL timeline uses its index and stable same-second composite cursor',()=>{
 const f=fixture(1200);try{
  const sql=`SELECT rowid FROM ${f.table} WHERE (create_time,rowid)<(1700000000,1101) ORDER BY create_time DESC,rowid DESC LIMIT 500`;
  assert.deepEqual(f.db.prepare(sql).all().map(r=>r.local_id??r.rowid),Array.from({length:500},(_,i)=>1100-i));
  const plan=f.db.prepare('EXPLAIN QUERY PLAN '+sql).all().map(r=>r.detail).join(' ');assert.match(plan,/INDEX timeline/);assert.doesNotMatch(plan,/TEMP B-TREE/);
 }finally{f.db.close();fs.rmSync(f.root,{recursive:true,force:true})}
});
test('native timeout is bounded, eligible for SQL shrink, and successful small batches grow again',async()=>{
 const {pageLimits,retryableRead,growBatch}=require('../electron/wechat-sync-retry.cjs');
 assert.ok(retryableRead.has('NATIVE_TIMEOUT'));assert.deepEqual(pageLimits(500),[500,250,100,50,25,10,5,1]);assert.deepEqual(pageLimits(1),[1]);
 let state={size:500,streak:0};state=growBatch(state,1,500);assert.equal(state.size,1);
 for(let i=0;i<30;i++)state=growBatch(state,state.size,500);assert.equal(state.size,500);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mw-timeout-')),fake=path.join(root,'reader');
 fs.writeFileSync(fake,'#!/bin/sh\nread key\nread profile\nread query\nsleep 1\n',{mode:0o700});
 const reader=openBatchReader(fake,'unused','','4',{timeoutMs:10});
 try{await assert.rejects(reader.query('SELECT 1 LIMIT 500'),e=>e.code==='NATIVE_TIMEOUT');}finally{await reader.close();fs.rmSync(root,{recursive:true,force:true})}
});
test('a persisted oversized gap is reassembled without restarting its completed scan',async()=>{
 const f=fixture(3),store=new Store(':memory:');try{
  const body='\x01'.repeat(3*1024*1024);f.db.prepare(`UPDATE ${f.table} SET message_content=? WHERE local_id=2`).run(body);f.db.close();
  const account={id:'wechat:'+crypto.createHash('sha256').update(fs.realpathSync(f.root)).digest('hex'),name:'Synthetic'};
  store.importData({version:1,account,contacts:[{id:'peer',name:'Peer'}],messages:[1,3].map(i=>({id:`message/message_0.db:${f.table}:${i}`,chat:'peer',sender:'peer',timestamp:1700000000,text:'synthetic',kind:'text',outgoing:false}))});
  const snapshot=await require('../electron/wechat-snapshot.cjs').createSnapshot(path.join(f.root,'db_storage'),['message/message_0.db']);
  const fingerprint=snapshot.fingerprint;await snapshot.cleanup();const source='message/message_0.db:'+f.table;
  openGaps(store.db,account.id).record(source,'preview',fingerprint,{__rowid:'2',__time:'1700000000',local_id:'2'},'ROW_ASSEMBLY_FAILED');
  store.db.exec('CREATE TABLE wechat_sync_cursor(account TEXT,source TEXT,fingerprint TEXT,phase TEXT,cursor TEXT,done INTEGER,scanned INTEGER,skipped INTEGER,scan_complete INTEGER,PRIMARY KEY(account,source,fingerprint,phase))');
  store.db.prepare('INSERT INTO wechat_sync_cursor VALUES(?,?,?,?,?,0,3,0,1)').run(account.id,source,fingerprint,'preview',JSON.stringify(['1700000000','1']));
  const result=await importWeChat(store,f.args,helper,()=>{},{wait:async()=>{}});
  assert.equal(result.added,1);assert.equal(result.failedTables,0);assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,3);
  assert.equal(store.db.prepare("SELECT scanned FROM wechat_sync_cursor WHERE phase='preview'").get().scanned,3);
  assert.equal(store.db.prepare('SELECT count(*) n FROM wechat_sync_gaps WHERE resolved_at IS NULL').get().n,0);
  assert.equal(store.db.prepare("SELECT text FROM messages WHERE id LIKE '%:2'").get().text,body);
 }finally{store.close();fs.rmSync(f.root,{recursive:true,force:true})}
});
