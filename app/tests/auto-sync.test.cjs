const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {Store}=require('../electron/store.cjs'),{importWeChat}=require('../electron/wechat-adapter.cjs');
const {AutoSync,authorizations}=require('../electron/auto-sync.cjs');
const helper=path.resolve('native/.build/wechat-reader'),control={wait:async()=>{}};
function fixture(n=50){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mw-038-'));for(const sub of ['contact','message'])fs.mkdirSync(path.join(root,'db_storage',sub),{recursive:true});
 const contact=new DatabaseSync(path.join(root,'db_storage/contact/contact.db'));contact.exec("CREATE TABLE contact(username TEXT,nick_name TEXT);INSERT INTO contact VALUES('peer','Synthetic peer')");contact.close();
 const file=path.join(root,'db_storage/message/message_0.db'),db=new DatabaseSync(file);const table='Msg_'+crypto.createHash('md5').update('peer').digest('hex');
 db.exec(`CREATE TABLE ${table}(local_id INTEGER PRIMARY KEY,create_time INTEGER NOT NULL,message_content,local_type INTEGER,is_send INTEGER);CREATE INDEX timeline ON ${table}(create_time)`);
 const put=db.prepare(`INSERT INTO ${table}(local_id,create_time,message_content,local_type,is_send) VALUES(?,1700000000,?,1,0)`);db.exec('BEGIN');for(let i=1;i<=n;i++)put.run(i,'synthetic '+i);db.exec('COMMIT');db.close();
 const workspace=path.join(root,'workspace.sqlite');let store=new Store(workspace);
 return {root,file,table,workspace,args:{root,selfId:'self',profile:'4',allowDecrypted:true},get store(){return store},reopen(){store.close();store=new Store(workspace)},append(start,n=1){const db=new DatabaseSync(file),put=db.prepare(`INSERT INTO ${table}(local_id,create_time,message_content,local_type,is_send) VALUES(?,1700000000,?,1,0)`);db.exec('BEGIN');for(let i=start;i<start+n;i++)put.run(i,'synthetic '+i);db.exec('COMMIT');db.close()},close(){store.close();fs.rmSync(root,{recursive:true,force:true})}};
}
const run=(f,extra={},progress=()=>{},gate=control)=>importWeChat(f.store,{...f.args,incremental:true,...extra},helper,progress,gate);
test('daily incremental reads append rows after completed history, seeds upgrade without history scan, then survives 10 changed snapshots and restart',async()=>{
 const f=fixture(75);try{
  const old=await importWeChat(f.store,f.args,helper,()=>{},control);assert.equal(old.added,75);
  const history=JSON.stringify(f.store.db.prepare('SELECT * FROM wechat_sync_cursor').all());
  const seed=await run(f);assert.equal(seed.added,0);assert.equal(seed.scanned,0);
  for(let i=0;i<10;i++){
   f.append(76+i);if(i===4)f.reopen();const r=await run(f);assert.equal(r.added,1);assert.equal(r.scanned-r.checkpointScanned,1);
  }
  assert.equal((await run(f)).added,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,85);
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM wechat_sync_cursor').all()),history);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM wechat_incremental_cursor').get().n,1);
 }finally{f.close()}
});
test('same-second messages, duplicate local IDs and new message shard are discovered independently',async()=>{
 const f=fixture(2);try{
  await run(f);f.append(3,3);
  const db=new DatabaseSync(path.join(f.root,'db_storage/message/message_1.db'));db.exec(`CREATE TABLE ${f.table}(local_id,create_time INTEGER NOT NULL,message_content,local_type,is_send);INSERT INTO ${f.table} VALUES(1,1700000000,'one',1,0),(1,1700000000,'two',1,0)`);db.close();
  const r=await run(f);assert.equal(r.added,5);assert.equal((await run(f)).added,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,7);
 }finally{f.close()}
});
test('daily malformed row persists gap, later valid rows commit; historical gaps are untouched and repaired separately',async()=>{
 const f=fixture(10);try{
  let db=new DatabaseSync(f.file);db.exec(`UPDATE ${f.table} SET message_content=CAST(x'ff' AS TEXT) WHERE local_id=5`);db.close();
  const r=await run(f);assert.equal(r.added,9);assert.equal(r.failedTables,1);assert.ok(f.store.db.prepare("SELECT 1 FROM messages WHERE id LIKE '%:10'").get());
  f.append(11);assert.equal((await run(f)).added,1);
  db=new DatabaseSync(f.file);db.exec(`UPDATE ${f.table} SET message_content='recovered' WHERE local_id=5`);db.close();
  assert.equal((await run(f)).added,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM wechat_sync_gaps WHERE resolved_at IS NULL').get().n,0);
 }finally{f.close()}
});
test('byte-only boundary change requires full prefix proof, then appends without rewriting local edits',async()=>{
 const f=fixture(270);try{
  let db=new DatabaseSync(f.file);db.exec(`ALTER TABLE ${f.table} ADD COLUMN volatile_extra TEXT`);db.close();
  await run(f);
  const msg=f.store.db.prepare("SELECT account,rowid FROM messages WHERE id LIKE '%:50'").get();
  f.store.edit({...msg,text:'local overlay',note:'synthetic note',ts:1700000000,hidden:false});
  db=new DatabaseSync(f.file);db.exec(`UPDATE ${f.table} SET volatile_extra='updated' WHERE local_id=270`);db.close();f.append(271);
  assert.equal((await run(f)).failedTables,1);
  const old=f.store.db.prepare('SELECT * FROM wechat_incremental_cursor').get();
  const repaired=await run(f,{forceCheck:true});
  assert.equal(repaired.added,1);assert.equal(repaired.failedTables,0);assert.equal(repaired.integrityIssues,0);
  assert.equal(f.store.db.prepare('SELECT rows_verified FROM wechat_source_reconciliation').get().rows_verified,270);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM wechat_source_discrepancy').get().n,1);
  assert.equal(f.store.db.prepare('SELECT text FROM edits WHERE message=?').get(msg.rowid).text,'local overlay');
  assert.notEqual(f.store.db.prepare('SELECT cursor FROM wechat_incremental_cursor').get().cursor,old.cursor);
  assert.equal((await run(f,{forceCheck:true})).added,0);
 }finally{f.close()}
});
test('reconciliation cannot bypass a changed or missing middle row with unchanged boundary content',async()=>{
 for(const mutation of ['change','delete','backfill']){
  const f=fixture(270);try{
   let db=new DatabaseSync(f.file);
   db.exec(`ALTER TABLE ${f.table} ADD COLUMN volatile_extra TEXT`);
   if(mutation==='backfill')db.exec(`DELETE FROM ${f.table} WHERE local_id=100`);
   db.close();await run(f);const checkpoint=f.store.db.prepare('SELECT * FROM wechat_incremental_cursor').get();
   db=new DatabaseSync(f.file);
   db.exec(`UPDATE ${f.table} SET volatile_extra='updated' WHERE local_id=270`);
   if(mutation==='change')db.exec(`UPDATE ${f.table} SET message_content='replacement' WHERE local_id=100`);
   if(mutation==='delete')db.exec(`DELETE FROM ${f.table} WHERE local_id=100`);
   if(mutation==='backfill')db.exec(`INSERT INTO ${f.table} VALUES(100,1700000000,'backfill',1,0,NULL)`);
   db.close();f.append(271);
   const repaired=await run(f,{forceCheck:true});
   assert.equal(repaired.added,0);assert.equal(repaired.failedTables,1);
   assert.deepEqual(f.store.db.prepare('SELECT * FROM wechat_incremental_cursor').get(),checkpoint);
   assert.equal(f.store.db.prepare('SELECT count(*) n FROM wechat_source_reconciliation').get().n,0);
  }finally{f.close()}
 }
});
test('anchor content replacement fails closed without advancing cursor or altering archived messages',async()=>{
 const f=fixture(10);try{await run(f);const before=f.store.db.prepare('SELECT * FROM wechat_incremental_cursor').get();const db=new DatabaseSync(f.file);db.exec(`UPDATE ${f.table} SET message_content='replacement' WHERE local_id=10`);db.close();
  const r=await run(f);assert.equal(r.failedTables,1);assert.equal(r.added,0);assert.deepEqual(f.store.db.prepare('SELECT * FROM wechat_incremental_cursor').get(),before);assert.equal(f.store.db.prepare('SELECT kind FROM wechat_sync_retry WHERE resolved_at IS NULL').get().kind,'SOURCE_CHANGED');
 }finally{f.close()}
});
test('cancellation stops further batches and reopening resumes the committed daily cursor',async()=>{
 const f=fixture(1300);let cancel=false;try{
  await assert.rejects(run(f,{},p=>{if(p.phase==='incremental'&&p.added>=500)cancel=true},{wait:async()=>{if(cancel)throw Error('synthetic cancellation')}}),/synthetic cancellation/);
  const count=f.store.db.prepare('SELECT count(*) n FROM messages').get().n;assert.ok(count>=500&&count<1300);f.reopen();assert.equal((await run(f)).added,1300-count);assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,1300);
 }finally{f.close()}
});
test('source digest and local favorites/edits/history checkpoints survive daily append, cached stats invalidated',async()=>{
 const f=fixture(2);try{
  await run(f);const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex');const before=hash();const first=f.store.db.prepare('SELECT rowid,* FROM messages LIMIT 1').get();
  require('../electron/archive-views.cjs').saveFavorite(f.store.db,{account:first.account,rowid:first.rowid,saved:true});
  const count=f.store.stats(first.account).summary.total;f.append(3);const actual=hash();await run(f);assert.equal(hash(),actual);assert.notEqual(before,actual);assert.equal(f.store.db.prepare('SELECT count(*) n FROM local_favorites').get().n,1);assert.equal(f.store.stats(first.account).summary.total,count+1);
 }finally{f.close()}
});
function fakeTimers(){let time=0,id=0;const timers=new Map();return {clock:()=>time,setTimer:(fn,ms)=>{const n=++id;timers.set(n,{fn,at:time+ms});return n},clearTimer:n=>timers.delete(n),count:()=>timers.size,async tick(ms){time+=ms;for(const [n,t] of [...timers])if(t.at<=time){timers.delete(n);t.fn()}await new Promise(r=>setImmediate(r))}}}
test('watch events debounce, concurrent requests coalesce, only success advances stamp, close clears all timers',async()=>{
 const timer=fakeTimers();let calls=0,finish,stamp='a',onchange;
 const sync=new AutoSync({...timer,stamp:()=>stamp,watch:(_p,fn)=>{onchange=fn;return {on(){},close(){}}},run:async()=>{calls++;return new Promise(r=>{finish=r})}});
 sync.configure('/synthetic',{enabled:true,interval:10});onchange('change','message_0.db-wal');onchange('change','message_0.db-wal');await timer.tick(650);assert.equal(calls,1);
 const one=sync.request('/synthetic');sync.request('/synthetic');stamp='b';finish({added:1});await one;await timer.tick(650);assert.equal(calls,2);finish({added:0});await sync.jobs.get('/synthetic').promise;sync.close();assert.equal(timer.count(),0);
});
test('finite retries, auth failure stops automatic attempts, disabling prevents future timers and manual remains possible',async()=>{
 const timer=fakeTimers();let calls=0;const sync=new AutoSync({...timer,probeInterval:600000,stamp:()=>calls,watch:()=>{throw Error('backend unavailable')},run:async()=>{calls++;throw Error('fail')}});
 sync.configure('/s',{enabled:true,interval:10});await assert.rejects(sync.request('/s','startup'));await timer.tick(30000);await timer.tick(60000);await timer.tick(120000);assert.equal(calls,3);
 sync.configure('/s',{enabled:false,interval:5});await timer.tick(600000);assert.equal(calls,3);await assert.rejects(sync.request('/s'));assert.equal(calls,4);sync.close();assert.equal(timer.count(),0);
 const auth=new AutoSync({...timer,stamp:()=>1,watch:()=>({on(){},close(){}}),run:async()=>{throw Object.assign(Error('bad'),{code:'DB_FORMAT'})}});auth.configure('/s',{enabled:true,interval:5});await assert.rejects(auth.request('/s','startup'));assert.equal(auth.jobs.get('/s').blocked,true);auth.close();
});
test('encrypted authorization lifecycle restores two account scopes, rejects binding changes and unavailable storage; never stores keys as metadata',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mw-auth-')),file=path.join(root,'auth.enc'),key=crypto.randomBytes(32);const secure={available:()=>true,encrypt:s=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(s),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body])},decrypt:b=>{const d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString()}};
 try{for(const n of ['a','b'])fs.mkdirSync(path.join(root,n));let a=authorizations(file,secure);a.save(path.join(root,'a'),{selfId:'self-a',key:'never persist metadata'});a.save(path.join(root,'b'),{selfId:'self-b'});a.update(path.join(root,'b'),{enabled:false,interval:5});a=authorizations(file,secure);assert.equal(a.list().length,2);assert.equal(a.get(path.join(root,'a')).options.selfId,'self-a');assert.equal(a.get(path.join(root,'b')).enabled,false);assert.ok(!fs.readFileSync(file).includes(Buffer.from('self-a')));assert.ok(!secure.decrypt(fs.readFileSync(file)).includes('never persist'));
  fs.renameSync(path.join(root,'a'),path.join(root,'old'));fs.mkdirSync(path.join(root,'a'));assert.equal(a.check(path.join(root,'a')),'sourceChanged');assert.equal(authorizations(file,{...secure,available:()=>false}).issue,'storageUnavailable');assert.throws(()=>a.update(path.join(root,'b'),{interval:7}));
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('external salt fingerprint cache is explicit, salt-bound and rejects ambiguous/raw-path mixed formats',()=>{
 const {keysForDatabases}=require('../electron/wechat-keys.cjs');const root=fs.mkdtempSync(path.join(os.tmpdir(),'mw-keyformat-')),file=path.join(root,'source');try{
  const salt='12'.repeat(16),derived='34'.repeat(32);fs.writeFileSync(file,Buffer.from(salt,'hex'));const input=JSON.stringify({['a'.repeat(16)+':'+salt]:derived});const select=keysForDatabases(input);assert.equal(select.derived,true);assert.equal(select('arbitrary/path.db',file),derived);
  assert.throws(()=>keysForDatabases(JSON.stringify({['a'.repeat(16)+':'+salt]:derived,['b'.repeat(16)+':'+salt]:'56'.repeat(32)}))('x',file),/多个 Raw Key/);
  assert.throws(()=>keysForDatabases(JSON.stringify({['a'.repeat(16)+':'+salt]:derived,'contact/contact.db':derived})),/不能混用/);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('empty source table later receives its first row without losing the new boundary',async()=>{
 const f=fixture(0);try{assert.equal((await run(f)).added,0);f.append(1);assert.equal((await run(f)).added,1);assert.equal((await run(f)).added,0)}finally{f.close()}
});
test('same account requests are mutually exclusive and independent account failures do not share credentials or stamps',async()=>{
 const timer=fakeTimers(),calls=[];let finish;
 const sync=new AutoSync({...timer,stamp:()=>1,watch:()=>({on(){},close(){}}),run:async root=>{calls.push(root);return root==='/a'?new Promise(r=>finish=r):{added:2}}});
 for(const root of ['/a','/b'])sync.configure(root,{enabled:true,interval:5});
 const a=sync.request('/a'),same=sync.request('/a');await sync.request('/b');assert.deepEqual(calls,['/a','/b']);finish({added:1});await Promise.all([a,same]);sync.close();
});
test('polling fallback checks at configured interval, failed refresh retains stamp and saved raw database key never falls back to media',async()=>{
 const timer=fakeTimers();let calls=0;const sync=new AutoSync({...timer,stamp:()=>1,watch:()=>{throw Error('unavailable')},run:async()=>{calls++;return {added:0}}});sync.configure('/s',{enabled:true,interval:5});await timer.tick(3999);assert.equal(calls,0);await timer.tick(1);assert.equal(calls,1);await timer.tick(4000);assert.equal(calls,1);await timer.tick(292000);assert.equal(calls,2);sync.close();
 const {sourceCredential}=require('../electron/wechat-retry-context.cjs');assert.equal(sourceCredential('/s',new Map(),{hasKey:(_root,scope)=>scope==='media',loadKey:()=>{throw Error('media was accessed')}}),'');
});
test('safe snapshot changing source is rejected and can be retried; source digest remains unchanged by readers',async()=>{
 const f=fixture(5),copy=fs.promises.copyFile;let changed=false;
 try{fs.promises.copyFile=async(...args)=>{await copy(...args);if(!changed&&fs.realpathSync(args[0])===fs.realpathSync(f.file)){changed=true;f.append(6)}};const failed=await run(f);assert.equal(failed.failedTables,1);assert.equal(failed.added,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,0);
  fs.promises.copyFile=copy;const hash=crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex');assert.equal((await run(f)).added,6);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),hash);
 }finally{fs.promises.copyFile=copy;f.close()}
});
test('historical pending work is not misrepresented as daily sync failure or marked resolved',async()=>{
 const f=fixture(2);try{await run(f);const account=f.store.accounts()[0].id;const source='message/message_0.db:'+f.table;f.store.db.prepare('INSERT INTO wechat_sync_retry VALUES(?,?,?,?,?,?,?,NULL)').run(account,source,'history',null,'999','ROW_GAPS',Date.now());f.append(3);
  const r=await run(f);assert.equal(r.added,1);assert.equal(r.failedTables,0);assert.equal(r.historicalPending,1);assert.equal(f.store.db.prepare("SELECT resolved_at FROM wechat_sync_retry WHERE phase='history'").get().resolved_at,null);
 }finally{f.close()}
});

function mutate(f,sql){const db=new DatabaseSync(f.file);try{db.exec(sql)}finally{db.close()}}
function issues(f){return f.store.db.prepare('SELECT kind,affected FROM wechat_source_discrepancy ORDER BY kind').all().map(x=>[x.kind,x.affected])}
test('middle row changes and deletion, plus backfill below watermark are detected by full audit without rewriting archive',async()=>{
 const f=fixture(1000);try{
  mutate(f,`DELETE FROM ${f.table} WHERE local_id=400`);
  await run(f);
  const before=f.store.db.prepare("SELECT rowid,* FROM messages WHERE id LIKE '%:500'").get();
  f.store.edit({account:before.account,rowid:before.rowid,text:'synthetic local edit',note:'',hidden:false,ts:before.ts});
  require('../electron/archive-views.cjs').saveFavorite(f.store.db,{account:before.account,rowid:before.rowid,saved:true});
  mutate(f,`UPDATE ${f.table} SET message_content='changed mid-row' WHERE local_id=500;DELETE FROM ${f.table} WHERE local_id=600;INSERT INTO ${f.table} VALUES(400,1700000000,'late older row',1,0)`);
  f.append(1001);const fast=await run(f);assert.equal(fast.added,1);assert.deepEqual(issues(f),[]);
  const history=f.store.db.prepare('SELECT * FROM wechat_sync_cursor').all();
  const full=await run(f,{auditMode:'full'});assert.equal(full.added,0);assert.deepEqual(issues(f),[['SOURCE_ROW_BELOW_WATERMARK',1],['SOURCE_ROW_CHANGED',1],['SOURCE_ROW_MISSING',1]]);
  assert.equal(f.store.db.prepare("SELECT text FROM messages WHERE id LIKE '%:500'").get().text,before.text);
  assert.equal(f.store.db.prepare("SELECT text FROM effective WHERE rowid=?").get(before.rowid).text,'synthetic local edit');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM local_favorites').get().n,1);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM wechat_sync_cursor').all(),history);
  assert.ok(f.store.db.prepare("SELECT 1 FROM messages WHERE id LIKE '%:600'").get());assert.equal(f.store.db.prepare("SELECT 1 FROM messages WHERE id LIKE '%:400'").get(),undefined);
 }finally{f.close()}
});
test('recent overlap detects edits, missing rows and late arrivals without waiting for the full audit',async()=>{
 const f=fixture(1000);try{
  mutate(f,`DELETE FROM ${f.table} WHERE local_id=920`);await run(f);
  mutate(f,`UPDATE ${f.table} SET message_content='recent changed' WHERE local_id=950;DELETE FROM ${f.table} WHERE local_id=970;INSERT INTO ${f.table} VALUES(920,1700000000,'late row',1,0)`);
  f.append(1001);const r=await run(f);assert.equal(r.added,1);assert.equal(r.integrityIssues,3);assert.deepEqual(issues(f),[['SOURCE_ROW_BELOW_WATERMARK',1],['SOURCE_ROW_CHANGED',1],['SOURCE_ROW_MISSING',1]]);
 }finally{f.close()}
});
test('replacement with identical first and boundary row is rejected before append',async()=>{
 const f=fixture(1000);try{
  await run(f);const checkpoint=f.store.db.prepare('SELECT * FROM wechat_incremental_cursor').get();const replacement=f.file+'.replacement';
  fs.copyFileSync(f.file,replacement);fs.renameSync(replacement,f.file);f.append(1001);
  const result=await run(f);assert.equal(result.added,0);assert.equal(result.incrementalFailure,'SOURCE_CHANGED');assert.deepEqual(f.store.db.prepare('SELECT * FROM wechat_incremental_cursor').get(),checkpoint);
  assert.deepEqual(issues(f),[['SOURCE_FILE_REPLACED_OR_SALT_CHANGED',1]]);
 }finally{f.close()}
});
test('changed encrypted Salt at the same inode invalidates fast receipt and persists a source discrepancy',async()=>{
 const f=fixture(0),key='ab'.repeat(32),grantId='fixture-grant';try{
  const writer=path.resolve('native/.build/encrypted-fixture');
  for(const [relative,kind] of [['contact/contact.db','contact'],['message/message_0.db','message']]){
   const file=path.join(f.root,'db_storage',relative);fs.unlinkSync(file);require('node:child_process').execFileSync(writer,[file,kind],{input:key});
  }
  const args={key,grantId,allowDecrypted:false};assert.equal((await run(f,args)).added,2);
  assert.equal((await run(f,args)).unchanged,true);
  const inode=fs.statSync(f.file).ino,fd=fs.openSync(f.file,'r+');try{const h=Buffer.alloc(16);fs.readSync(fd,h);h[0]^=255;fs.writeSync(fd,h,0,16,0)}finally{fs.closeSync(fd)}
  assert.equal(fs.statSync(f.file).ino,inode);
  const r=await run(f,args);assert.equal(r.unchanged,undefined);assert.equal(r.incrementalFailure,'SOURCE_CHANGED');assert.equal(r.added,0);assert.equal(issues(f)[0][0],'SOURCE_FILE_REPLACED_OR_SALT_CHANGED');
 }finally{f.close()}
});
test('receipt survives restart, is grant-bound, expires into full audit, and does not advance on interruption',async()=>{
 const f=fixture(1000),args={grantId:'fixture-grant'};try{
  await run(f,args);f.reopen();
  const receiptBefore=f.store.db.prepare('SELECT * FROM wechat_source_receipt').get();
  const retry=require('../electron/wechat-sync-retry.cjs').openRetryQueue(f.store.db,receiptBefore.account);
  retry.defer({source:'synthetic-history',phase:'history'},{code:'TEST'});
  const quick=await run(f,args);assert.equal(quick.unchanged,true);assert.equal(quick.verifiedAt,receiptBefore.verified_at);assert.equal(quick.historicalPending,1);assert.equal(quick.timings.snapshotWal,0);assert.equal(quick.timings.contacts,0);
  retry.defer({source:'synthetic-incremental',phase:'incremental'},{code:'TEST'});
  assert.equal((await run(f,args)).unchanged,undefined);
  retry.resolve('synthetic-incremental','incremental');
  assert.equal((await run(f,{...args,grantId:'second-grant'})).unchanged,undefined);
  f.store.db.exec('UPDATE wechat_source_receipt SET audit_due=0');const r=await run(f,{grantId:'second-grant'});assert.equal(r.unchanged,undefined);assert.ok(r.timings.audit>0);
  const receipt=f.store.db.prepare('SELECT * FROM wechat_source_receipt').get();
  f.append(1001,501);let cancelled=false;
  await assert.rejects(run(f,{grantId:'second-grant'},p=>{if(p.phase==='incremental'&&p.added>=500)cancelled=true},{wait:async()=>{if(cancelled)throw Error('synthetic interruption')}}),/synthetic interruption/);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM wechat_source_receipt').get(),receipt);
  assert.equal((await run(f,{grantId:'second-grant'})).added,1);
 }finally{f.close()}
});
test('WAL commits invalidate unchanged receipt, and scheduler wake checks enabled accounts',async()=>{
 const f=fixture(5),args={grantId:'fixture-grant'};let live;try{
  live=new DatabaseSync(f.file);live.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0');
  await run(f,args);assert.equal((await run(f,args)).unchanged,true);
  live.exec(`INSERT INTO ${f.table} VALUES(6,1700000000,'synthetic WAL',1,0)`);
  const wal=f.file+'-wal',digest=crypto.createHash('sha256').update(fs.readFileSync(wal)).digest('hex');
  const r=await run(f,args);assert.equal(r.added,1);assert.equal(r.walFiles,1);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(wal)).digest('hex'),digest);
  const timer=fakeTimers(),seen=[];const auto=new AutoSync({...timer,watch:()=>{throw Error('fallback')},stamp:()=>1,run:async(_root,why)=>{seen.push(why);return {unchanged:true}}});
  auto.configure('/enabled',{enabled:true,interval:10});auto.configure('/disabled',{enabled:false,interval:10});auto.wake();await new Promise(r=>setImmediate(r));assert.deepEqual(seen,['wake']);auto.close();
 }finally{live?.close();f.close()}
});

test('one changed shard skips snapshots of unchanged contact and message databases',async()=>{
 const f=fixture(5),args={grantId:'fixture-grant'};try{
  const second=path.join(path.dirname(f.file),'message_1.db');fs.copyFileSync(f.file,second);
  await run(f,args);const copies=[];
  f.append(6);const r=await run(f,args,p=>{if(p.stage==='正在校验数据库副本')copies.push(p.file)});
  assert.deepEqual(copies,['message/message_0.db']);assert.equal(r.added,1);
  assert.equal((await run(f,args)).unchanged,true);
 }finally{f.close()}
});
test('probe retries an unchanged temporarily failing source after bounded cooldown',async()=>{
 const timer=fakeTimers();let calls=0;
 const sync=new AutoSync({...timer,stamp:()=>1,probeInterval:10,retryDelay:5,cooldown:100,watch:()=>{throw Error('fallback')},run:async()=>{if(++calls<=3)throw Object.assign(Error('temporarily busy'),{code:'EIO'});return {added:1}}});
 sync.configure('/fixture',{enabled:true,interval:10});await assert.rejects(sync.request('/fixture','startup'));
 await timer.tick(5);await timer.tick(10);assert.equal(calls,3);
 await timer.tick(50);assert.equal(calls,3);
 await timer.tick(100);assert.equal(calls,4);sync.close();
});

test('100 successive same-second appends and bulk 100 and 10,000 remain complete and unique',async()=>{
 const f=fixture(1),args={grantId:'fixture-grant'};try{
  await run(f,args);
  for(let i=2;i<=101;i++){f.append(i);assert.equal((await run(f,args)).added,1);}
  f.append(102,100);assert.equal((await run(f,args)).added,100);
  f.append(202,10000);assert.equal((await run(f,args)).added,10000);
  assert.equal((await run(f,args)).added,0);
  assert.deepEqual({...f.store.db.prepare('SELECT count(*) n,count(DISTINCT id) unique_n FROM messages').get()},{n:10201,unique_n:10201});
 }finally{f.close()}
});

test('505 tables: identity failure stays pending while 504 append; clean snapshots stay selective after restart',async()=>{
 const f=fixture(2),options={grantId:'fixture-partial-grant'};try{
  const directory=path.dirname(f.file),bad=path.join(directory,'message_1.db');
  fs.copyFileSync(f.file,bad);
  const db=new DatabaseSync(f.file);
  const tables=[f.table,...Array.from({length:503},(_,i)=>'Msg_'+crypto.createHash('md5').update('fixture-peer-'+i).digest('hex'))];
  db.exec('BEGIN');
  for(const table of tables.slice(1))db.exec(`CREATE TABLE ${table}(local_id INTEGER PRIMARY KEY,create_time INTEGER NOT NULL,message_content,local_type INTEGER,is_send INTEGER); INSERT INTO ${table} VALUES(1,1700000000,'one',1,0),(2,1700000000,'two',1,0)`);
  db.exec('COMMIT');db.close();
  assert.equal((await run(f,options)).added,1010);
  let writer=new DatabaseSync(bad);
  writer.exec(`UPDATE ${f.table} SET message_content='different' WHERE local_id=2; INSERT INTO ${f.table} VALUES(3,1700000000,'pending append',1,0)`);writer.close();
  writer=new DatabaseSync(f.file);writer.exec('BEGIN');
  for(const table of tables)writer.exec(`INSERT INTO ${table} VALUES(3,1700000000,'healthy append',1,0)`);
  writer.exec('COMMIT');writer.close();
  const t=performance.now(),partial=await run(f,options),partialMs=performance.now()-t;
  assert.equal(partial.added,504);assert.equal(partial.failedTables,1);
  assert.equal(partial.pendingShards[0].kind,'SOURCE_CHANGED');
  assert.equal(f.store.db.prepare('SELECT kind FROM wechat_query_diagnostics ORDER BY occurred_at DESC LIMIT 1').get().kind,'ANCHOR_BOUNDARY_CHANGED');
  f.reopen();
  const copied=[];const repeat=await run(f,options,p=>{if(p.stage==='正在校验数据库副本')copied.push(p.file)});
  assert.deepEqual(copied,['message/message_1.db']);assert.equal(repeat.added,0);assert.equal(repeat.failedTables,1);
  writer=new DatabaseSync(bad);
  writer.exec(`UPDATE ${f.table} SET message_content='synthetic 2' WHERE local_id=2`);writer.close();
  const recovered=await run(f,options);assert.equal(recovered.failedTables,0);assert.equal(recovered.added,1);
  assert.equal((await run(f,options)).unchanged,true);
  assert.deepEqual({...f.store.db.prepare('SELECT count(*) n,count(DISTINCT id) distinct_n FROM messages').get()},{n:1515,distinct_n:1515});
  console.log(JSON.stringify({fixtureTables:505,partialMs:Math.round(partialMs),healthyAppends:504,recovered:1}));
 }finally{f.close()}
});

test('partial worker result is not a scheduler failure; new changes and polling still run',async()=>{
 const timer=fakeTimers(),events=[];let stamp='initial',calls=0;
 const sync=new AutoSync({...timer,stamp:()=>stamp,watch:()=>({on(){},close(){}}),status:(_,p)=>events.push(p),
  run:async()=>++calls<3?{added:calls===1?1:0,completedIncremental:1,failedTables:1,incrementalFailure:'SOURCE_CHANGED'}:{added:1}});
 sync.configure('/fixture',{enabled:true,interval:10});await timer.tick(1);
 assert.equal((await sync.request('/fixture','startup')).added,1);
 assert.equal(events.at(-1).state,'partial');assert.equal(events.at(-1).failure,'SHARD_CHANGED');
 assert.equal(events.at(-1).lastCommit,1);assert.equal(events.at(-1).lastNormalCheck,1);assert.equal(events.at(-1).lastSuccess,undefined);
 assert.equal(await sync.request('/fixture','probe'),false);
 stamp='changed';assert.equal((await sync.request('/fixture','event')).added,0);assert.equal(events.at(-1).lastCommit,undefined);
 assert.equal((await sync.request('/fixture','poll')).added,1);
 assert.equal(events.at(-1).state,'verified');assert.equal(events.at(-1).lastSuccess,1);sync.close();
});

test('disappeared table keeps its cursor and becomes verifiable if its anchors return',async()=>{
 const f=fixture(2),options={grantId:'fixture-missing-table'};try{
  await run(f,options);
  const before=f.store.db.prepare('SELECT * FROM wechat_incremental_cursor').get();
  const source=new DatabaseSync(f.file);
  source.exec(`ALTER TABLE ${f.table} RENAME TO renamed;`);
  const partial=await run(f,options);
  assert.equal(partial.failedTables,1);assert.equal(partial.added,0);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM wechat_incremental_cursor').get(),before);
  assert.equal(f.store.db.prepare('SELECT kind FROM wechat_query_diagnostics').get().kind,'SOURCE_TABLE_MISSING');
  source.exec(`ALTER TABLE renamed RENAME TO ${f.table};INSERT INTO ${f.table} VALUES(3,1700000000,'restored',1,0)`);
  source.close();
  const after=await run(f,options);assert.equal(after.failedTables,0);assert.equal(after.added,1);
 }finally{f.close()}
});

test('transient partial retries are bounded and a changed stamp can still run',async()=>{
 const timer=fakeTimers();let calls=0,stamp=1;
 const sync=new AutoSync({...timer,probeInterval:600000,retryDelay:5,stamp:()=>stamp,watch:()=>({on(){},close(){}}),
  run:async()=>++calls<4?{added:0,failedTables:1,pendingShards:[{kind:'NATIVE_TIMEOUT'}]}:{added:1}});
 sync.configure('/fixture',{enabled:true,interval:10});await sync.request('/fixture','startup');
 await timer.tick(5);await timer.tick(10);await timer.tick(50);assert.equal(calls,3);
 stamp=2;assert.equal((await sync.request('/fixture','probe')).added,1);sync.close();
});

test('all supported polling intervals persist; new authorization defaults to two minutes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mw-interval-')),file=path.join(root,'grants');const secure={available:()=>true,encrypt:s=>Buffer.from(s),decrypt:b=>b.toString()};
 try{const auth=authorizations(file,secure);assert.equal(auth.save(root,{}).interval,2);for(const interval of [1,2,3,5,10,15,30]){auth.update(root,{interval});assert.equal(authorizations(file,secure).get(root).interval,interval);assert.equal(auth.save(root,{}).interval,interval)}}finally{fs.rmSync(root,{recursive:true,force:true})}
});
